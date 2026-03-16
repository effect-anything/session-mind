import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Option, Path, Schema, Semaphore, ServiceMap } from "effect";
import { StateError } from "../errors/AppError";

const WORKFLOW_OUTPUT_DIRECTORY = ".output/session-mind";
const STATE_FILE_NAME = "state.json";
const PERSISTED_STATE_VERSION = 1;
export const WORKFLOW_MAX_RETRIES = 3;

export const WorkflowStatusSchema = Schema.Union([
  Schema.Literal("extracting"),
  Schema.Literal("generating"),
  Schema.Literal("executing"),
  Schema.Literal("validating"),
  Schema.Literal("complete"),
  Schema.Literal("failed"),
]);

export type WorkflowStatus = Schema.Schema.Type<typeof WorkflowStatusSchema>;

const ActiveWorkflowStatusSchema = Schema.Union([
  Schema.Literal("extracting"),
  Schema.Literal("generating"),
  Schema.Literal("executing"),
  Schema.Literal("validating"),
]);

export type ActiveWorkflowStatus = Schema.Schema.Type<typeof ActiveWorkflowStatusSchema>;

export const WorkflowArtifactsSchema = Schema.Struct({
  extractedSession: Schema.optional(Schema.String),
  promptBundle: Schema.optional(Schema.String),
  generatedArticle: Schema.optional(Schema.String),
});

export type WorkflowArtifacts = Schema.Schema.Type<typeof WorkflowArtifactsSchema>;

export const WorkflowFailureSchema = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  retryable: Schema.Boolean,
  recordedAt: Schema.Number,
  details: Schema.optional(Schema.Json),
});

export type WorkflowFailure = Schema.Schema.Type<typeof WorkflowFailureSchema>;

export const WorkflowStateSchema = Schema.Struct({
  sessionId: Schema.String,
  status: WorkflowStatusSchema,
  currentStep: Schema.String,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  completedAt: Schema.optional(Schema.Number),
  retryCount: Schema.Number,
  error: Schema.optional(WorkflowFailureSchema),
  artifacts: WorkflowArtifactsSchema,
});

export type WorkflowState = Schema.Schema.Type<typeof WorkflowStateSchema>;

const PersistedWorkflowStateSchema = Schema.Struct({
  version: Schema.Literal(PERSISTED_STATE_VERSION),
  updatedAt: Schema.Number,
  sessions: Schema.Array(WorkflowStateSchema),
});

type PersistedWorkflowState = Schema.Schema.Type<typeof PersistedWorkflowStateSchema>;

export const WorkflowRecoveryActionSchema = Schema.Union([
  Schema.Literal("resume"),
  Schema.Literal("resume-validation"),
]);

export type WorkflowRecoveryAction = Schema.Schema.Type<typeof WorkflowRecoveryActionSchema>;

export const WorkflowRecoverySchema = Schema.Struct({
  sessionId: Schema.String,
  previousStatus: WorkflowStatusSchema,
  resumeFromStatus: ActiveWorkflowStatusSchema,
  action: WorkflowRecoveryActionSchema,
  reason: Schema.String,
  retryCount: Schema.Number,
  state: WorkflowStateSchema,
});

export type WorkflowRecovery = Schema.Schema.Type<typeof WorkflowRecoverySchema>;

export type WorkflowTransitionOptions = {
  readonly currentStep?: string;
  readonly artifacts?: Partial<WorkflowArtifacts>;
  readonly completedAt?: number;
  readonly error?: WorkflowFailure;
};

export type WorkflowRetryResult = {
  readonly shouldRetry: boolean;
  readonly attemptsRemaining: number;
  readonly state: WorkflowState;
};

export type WorkflowStateManagerOptions = {
  readonly rootDirectory: string;
};

const decodePersistedState = Schema.decodeUnknownEffect(PersistedWorkflowStateSchema);

const ACTIVE_WORKFLOW_STATUSES = new Set<WorkflowStatus>([
  "extracting",
  "generating",
  "executing",
  "validating",
]);

const ALLOWED_TRANSITIONS: Readonly<Record<WorkflowStatus, ReadonlySet<WorkflowStatus>>> = {
  extracting: new Set(["extracting", "generating", "failed"]),
  generating: new Set(["generating", "executing", "failed"]),
  executing: new Set(["executing", "validating", "failed"]),
  validating: new Set(["validating", "complete", "failed"]),
  complete: new Set(["complete"]),
  failed: new Set(["failed", "extracting"]),
};

const emptyPersistedState = (now: number): PersistedWorkflowState => ({
  version: PERSISTED_STATE_VERSION,
  updatedAt: now,
  sessions: [],
});

const sortStates = (states: ReadonlyArray<WorkflowState>) =>
  [...states].sort((left, right) => left.sessionId.localeCompare(right.sessionId));

const isActiveWorkflowStatus = (status: WorkflowStatus): status is ActiveWorkflowStatus =>
  status !== "complete" && status !== "failed";

const normalizePath = (pathService: Path.Path, rootDirectory: string, targetPath: string) =>
  pathService.isAbsolute(targetPath) ? targetPath : pathService.resolve(rootDirectory, targetPath);

const withStateError = (
  code: string,
  message: string,
  context?: {
    readonly sessionId?: string;
    readonly path?: string;
    readonly currentStatus?: string;
    readonly nextStatus?: string;
  },
) =>
  new StateError({
    code,
    message,
    ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
    ...(context?.path ? { path: context.path } : {}),
    ...(context?.currentStatus ? { currentStatus: context.currentStatus } : {}),
    ...(context?.nextStatus ? { nextStatus: context.nextStatus } : {}),
  });

const makeFailure = (failure: {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Schema.Json | undefined;
}): WorkflowFailure => ({
  code: failure.code,
  message: failure.message,
  retryable: failure.retryable,
  recordedAt: Date.now(),
  ...(failure.details === undefined ? {} : { details: failure.details }),
});

const nextTransitionState = (
  state: WorkflowState,
  status: WorkflowStatus,
  options?: WorkflowTransitionOptions,
): WorkflowState => {
  const now = Date.now();
  const changedStatus = state.status !== status;

  return {
    ...state,
    status,
    currentStep: options?.currentStep ?? state.currentStep,
    updatedAt: now,
    completedAt: status === "complete" || status === "failed" ? (options?.completedAt ?? now) : undefined,
    retryCount: changedStatus ? 0 : state.retryCount,
    error: status === "failed" ? options?.error : (changedStatus ? undefined : (options?.error ?? state.error)),
    artifacts: {
      ...state.artifacts,
      ...options?.artifacts,
    },
  };
};

const replaceState = (
  states: ReadonlyArray<WorkflowState>,
  nextState: WorkflowState,
): ReadonlyArray<WorkflowState> => {
  const nextStates = [...states];
  const index = nextStates.findIndex((state) => state.sessionId === nextState.sessionId);

  if (index === -1) {
    nextStates.push(nextState);
  } else {
    nextStates[index] = nextState;
  }

  return sortStates(nextStates);
};

const removeState = (states: ReadonlyArray<WorkflowState>, sessionId: string): ReadonlyArray<WorkflowState> =>
  sortStates(states.filter((state) => state.sessionId !== sessionId));

export class WorkflowStateManager extends ServiceMap.Service<
  WorkflowStateManager,
  {
    readonly startWorkflow: (
      sessionId: string,
      currentStep?: string,
    ) => Effect.Effect<WorkflowState, StateError>;
    readonly getState: (
      sessionId: string,
    ) => Effect.Effect<Option.Option<WorkflowState>, StateError>;
    readonly listStates: () => Effect.Effect<ReadonlyArray<WorkflowState>, StateError>;
    readonly transition: (
      sessionId: string,
      status: WorkflowStatus,
      options?: WorkflowTransitionOptions,
    ) => Effect.Effect<WorkflowState, StateError>;
    readonly updateArtifacts: (
      sessionId: string,
      artifacts: Partial<WorkflowArtifacts>,
    ) => Effect.Effect<WorkflowState, StateError>;
    readonly markFailed: (
      sessionId: string,
      failure: Omit<WorkflowFailure, "recordedAt">,
    ) => Effect.Effect<WorkflowState, StateError>;
    readonly recordTransientFailure: (
      sessionId: string,
      failure: Omit<WorkflowFailure, "recordedAt" | "retryable">,
    ) => Effect.Effect<WorkflowRetryResult, StateError>;
    readonly recoverWorkflows: () => Effect.Effect<ReadonlyArray<WorkflowRecovery>, StateError>;
    readonly clearWorkflow: (sessionId: string) => Effect.Effect<void, StateError>;
    readonly getStateFilePath: () => string;
  }
>()("session-mind/WorkflowStateManager") {
  static readonly layer = WorkflowStateManager.layerAt({
    rootDirectory: process.cwd(),
  });

  static layerAt(options: WorkflowStateManagerOptions) {
    return Layer.effect(WorkflowStateManager)(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const lock = yield* Semaphore.make(1);

        const stateFilePath = path.resolve(
          options.rootDirectory,
          WORKFLOW_OUTPUT_DIRECTORY,
          STATE_FILE_NAME,
        );
        const stateDirectory = path.dirname(stateFilePath);

        const readStore = Effect.fn("WorkflowStateManager.readStore")(function* () {
          const exists = yield* fs.exists(stateFilePath).pipe(
            Effect.mapError((cause) =>
              withStateError("state-read-failed", String(cause), { path: stateFilePath }),
            ),
          );

          if (!exists) {
            return emptyPersistedState(Date.now());
          }

          const raw = yield* fs.readFileString(stateFilePath).pipe(
            Effect.mapError((cause) =>
              withStateError("state-read-failed", String(cause), { path: stateFilePath }),
            ),
          );

          const parsed = yield* Effect.try({
            try: () => JSON.parse(raw) as unknown,
            catch: (cause) =>
              withStateError("state-parse-failed", String(cause), { path: stateFilePath }),
          });

          return yield* decodePersistedState(parsed).pipe(
            Effect.mapError((cause) =>
              withStateError("state-decode-failed", String(cause), { path: stateFilePath }),
            ),
          );
        });

        const writeStore = (store: PersistedWorkflowState) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(stateDirectory, { recursive: true }).pipe(
              Effect.mapError((cause) =>
                withStateError("state-write-failed", String(cause), { path: stateDirectory }),
              ),
            );

            const tempPath = path.join(
              stateDirectory,
              `${STATE_FILE_NAME}.${Math.random().toString(36).slice(2)}.tmp`,
            );
            const payload = JSON.stringify(
              {
                ...store,
                sessions: sortStates(store.sessions),
              },
              null,
              2,
            );

            yield* fs.writeFileString(tempPath, payload).pipe(
              Effect.mapError((cause) =>
                withStateError("state-write-failed", String(cause), { path: tempPath }),
              ),
            );

            yield* fs.rename(tempPath, stateFilePath).pipe(
              Effect.mapError((cause) =>
                withStateError("state-write-failed", String(cause), { path: stateFilePath }),
              ),
            );
          });

        const modifyStore = <A>(
          f: (store: PersistedWorkflowState) => Effect.Effect<readonly [A, PersistedWorkflowState], StateError>,
        ) =>
          lock.withPermit(
            Effect.gen(function* () {
              const currentStore = yield* readStore();
              const [result, nextStore] = yield* f(currentStore);
              const storeToPersist = {
                ...nextStore,
                updatedAt: Date.now(),
                sessions: sortStates(nextStore.sessions),
              };

              yield* writeStore(storeToPersist);
              return result;
            }),
          );

        const getRequiredState = (
          store: PersistedWorkflowState,
          sessionId: string,
        ): Effect.Effect<WorkflowState, StateError> => {
          const state = store.sessions.find((item) => item.sessionId === sessionId);
          return state
            ? Effect.succeed(state)
            : Effect.fail(
                withStateError("state-not-found", `Workflow state not found for session ${sessionId}`, {
                  sessionId,
                  path: stateFilePath,
                }),
              );
        };

        const startWorkflow = Effect.fn("WorkflowStateManager.startWorkflow")(function* (
          sessionId: string,
          currentStep = "Extract session content",
        ) {
          return yield* modifyStore((store) => {
            const existingState = store.sessions.find((state) => state.sessionId === sessionId);
            const now = Date.now();

            const nextState: WorkflowState = existingState &&
                existingState.status !== "complete" &&
                existingState.status !== "failed"
              ? {
                  ...existingState,
                  currentStep,
                  updatedAt: now,
                }
              : {
                  sessionId,
                  status: "extracting",
                  currentStep,
                  startedAt: now,
                  updatedAt: now,
                  retryCount: 0,
                  artifacts: {},
                };

            return Effect.succeed([
              nextState,
              {
                ...store,
                sessions: replaceState(store.sessions, nextState),
              },
            ] as const);
          });
        });

        const getState = Effect.fn("WorkflowStateManager.getState")(function* (sessionId: string) {
          const store = yield* readStore();
          return Option.fromNullishOr(
            store.sessions.find((state) => state.sessionId === sessionId),
          );
        });

        const listStates = Effect.fn("WorkflowStateManager.listStates")(function* () {
          const store = yield* readStore();
          return sortStates(store.sessions);
        });

        const transition = Effect.fn("WorkflowStateManager.transition")(function* (
          sessionId: string,
          status: WorkflowStatus,
          options?: WorkflowTransitionOptions,
        ) {
          return yield* modifyStore((store) =>
            Effect.gen(function* () {
              const currentState = yield* getRequiredState(store, sessionId);
              const allowedTransitions = ALLOWED_TRANSITIONS[currentState.status];

              if (!allowedTransitions.has(status)) {
                return yield* (
                  withStateError(
                    "invalid-transition",
                    `Cannot transition workflow state from ${currentState.status} to ${status}`,
                    {
                      sessionId,
                      path: stateFilePath,
                      currentStatus: currentState.status,
                      nextStatus: status,
                    },
                  )
                );
              }

              const nextState = nextTransitionState(currentState, status, options);

              return [
                nextState,
                {
                  ...store,
                  sessions: replaceState(store.sessions, nextState),
                },
              ] as const;
            }),
          );
        });

        const updateArtifacts = Effect.fn("WorkflowStateManager.updateArtifacts")(function* (
          sessionId: string,
          artifacts: Partial<WorkflowArtifacts>,
        ) {
          return yield* modifyStore((store) =>
            Effect.gen(function* () {
              const currentState = yield* getRequiredState(store, sessionId);
              const nextState: WorkflowState = {
                ...currentState,
                updatedAt: Date.now(),
                artifacts: {
                  ...currentState.artifacts,
                  ...artifacts,
                },
              };

              return [
                nextState,
                {
                  ...store,
                  sessions: replaceState(store.sessions, nextState),
                },
              ] as const;
            }),
          );
        });

        const markFailed = Effect.fn("WorkflowStateManager.markFailed")(function* (
          sessionId: string,
          failure: Omit<WorkflowFailure, "recordedAt">,
        ) {
          return yield* transition(sessionId, "failed", {
            error: makeFailure(failure),
            currentStep: failure.message,
          });
        });

        const recordTransientFailure = Effect.fn("WorkflowStateManager.recordTransientFailure")(
          function* (
            sessionId: string,
            failure: Omit<WorkflowFailure, "recordedAt" | "retryable">,
          ) {
            return yield* modifyStore((store) =>
              Effect.gen(function* () {
                const currentState = yield* getRequiredState(store, sessionId);
                const retryCount = currentState.retryCount + 1;
                const error = makeFailure({
                  ...failure,
                  retryable: true,
                });

                if (retryCount > WORKFLOW_MAX_RETRIES) {
                  const failedState = nextTransitionState(currentState, "failed", {
                    error,
                    currentStep: `Retry limit exceeded for ${currentState.currentStep}`,
                  });
                  const result: WorkflowRetryResult = {
                    shouldRetry: false,
                    attemptsRemaining: 0,
                    state: failedState,
                  };

                  return [
                    result,
                    {
                      ...store,
                      sessions: replaceState(store.sessions, failedState),
                    },
                  ] as const;
                }

                const nextState: WorkflowState = {
                  ...currentState,
                  updatedAt: Date.now(),
                  retryCount,
                  error,
                };
                const result: WorkflowRetryResult = {
                  shouldRetry: true,
                  attemptsRemaining: WORKFLOW_MAX_RETRIES - retryCount,
                  state: nextState,
                };

                return [
                  result,
                  {
                    ...store,
                    sessions: replaceState(store.sessions, nextState),
                  },
                ] as const;
              }),
            );
          },
        );

        const recoverWorkflows = Effect.fn("WorkflowStateManager.recoverWorkflows")(function* () {
          const store = yield* readStore();
          const recoveries = yield* Effect.forEach(
            store.sessions.filter((state) => ACTIVE_WORKFLOW_STATUSES.has(state.status)),
            (state) =>
              Effect.gen(function* () {
                const generatedArticlePath = state.artifacts.generatedArticle;
                const generatedArticleExists = generatedArticlePath
                  ? yield* fs.exists(
                      normalizePath(path, options.rootDirectory, generatedArticlePath),
                    ).pipe(
                      Effect.mapError((cause) =>
                        withStateError("state-recovery-failed", String(cause), {
                          sessionId: state.sessionId,
                          path: generatedArticlePath,
                        }),
                      ),
                    )
                  : false;

                if (state.status === "executing" && generatedArticleExists) {
                  return {
                    sessionId: state.sessionId,
                    previousStatus: state.status,
                    resumeFromStatus: "validating",
                    action: "resume-validation",
                    reason: "Generated article already exists, resume validation.",
                    retryCount: state.retryCount,
                    state,
                  } satisfies WorkflowRecovery;
                }

                if (state.status === "validating" && !generatedArticleExists) {
                  return {
                    sessionId: state.sessionId,
                    previousStatus: state.status,
                    resumeFromStatus: "executing",
                    action: "resume",
                    reason: "Validation artifact is missing, resume execution to regenerate it.",
                    retryCount: state.retryCount,
                    state,
                  } satisfies WorkflowRecovery;
                }

                return {
                  sessionId: state.sessionId,
                  previousStatus: state.status,
                  resumeFromStatus: isActiveWorkflowStatus(state.status)
                    ? state.status
                    : "extracting",
                  action: "resume",
                  reason: "Resume the persisted workflow step.",
                  retryCount: state.retryCount,
                  state,
                } satisfies WorkflowRecovery;
              }),
          );

          return sortStates(recoveries.map((recovery) => recovery.state)).map((state) =>
            recoveries.find((recovery) => recovery.sessionId === state.sessionId)!,
          );
        });

        const clearWorkflow = Effect.fn("WorkflowStateManager.clearWorkflow")(function* (sessionId: string) {
          yield* modifyStore((store) =>
            Effect.succeed([
              undefined,
              {
                ...store,
                sessions: removeState(store.sessions, sessionId),
              },
            ] as const),
          );
        });

        return WorkflowStateManager.of({
          startWorkflow,
          getState,
          listStates,
          transition,
          updateArtifacts,
          markFailed,
          recordTransientFailure,
          recoverWorkflows,
          clearWorkflow,
          getStateFilePath: () => stateFilePath,
        });
      }),
    ).pipe(Layer.provideMerge(NodeFileSystem.layer), Layer.provideMerge(NodePath.layer));
  }
}
