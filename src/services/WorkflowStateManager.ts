import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect, Layer, Option, Schema, Semaphore, ServiceMap } from "effect";
import { ArticleStatusSchema, type ArticleStatus } from "../domain/Article.ts";
import { StateError } from "../domain/SessionMindErrors.ts";

export const WorkflowStageSchema = Schema.Literals([
  "extracting",
  "generating",
  "executing",
  "validating",
  "reviewing",
  "complete",
  "failed",
]);

export type WorkflowStage = Schema.Schema.Type<typeof WorkflowStageSchema>;

export const ActiveWorkflowStageSchema = Schema.Literals([
  "extracting",
  "generating",
  "executing",
  "validating",
  "reviewing",
]);

export type ActiveWorkflowStage = Schema.Schema.Type<typeof ActiveWorkflowStageSchema>;

export const SessionWorkflowStateSchema = Schema.Struct({
  sessionId: Schema.String,
  stage: WorkflowStageSchema,
  articleStatus: ArticleStatusSchema,
  artifactPath: Schema.String,
  promptBundlePath: Schema.optional(Schema.String),
  iteration: Schema.Number,
  lastValidationIssues: Schema.optional(Schema.Array(Schema.String)),
  updatedAt: Schema.Number,
  retryCount: Schema.Number,
  lastStableStage: Schema.optional(ActiveWorkflowStageSchema),
  lastError: Schema.optional(Schema.String),
});

export type SessionWorkflowState = Schema.Schema.Type<typeof SessionWorkflowStateSchema>;

export const WorkflowStateSchema = Schema.Struct({
  version: Schema.Number,
  sessions: Schema.Record(Schema.String, SessionWorkflowStateSchema),
});

export type WorkflowState = Schema.Schema.Type<typeof WorkflowStateSchema>;

export type WorkflowRecovery =
  | { readonly action: "start" }
  | {
      readonly action: "resume";
      readonly nextStage: ActiveWorkflowStage;
      readonly state: SessionWorkflowState;
    }
  | {
      readonly action: "complete";
      readonly state: SessionWorkflowState;
    };

export type InitializeSessionRequest = {
  readonly stateFilePath: string;
  readonly sessionId: string;
  readonly artifactPath: string;
  readonly articleStatus?: ArticleStatus;
};

export type TransitionWorkflowRequest = {
  readonly stateFilePath: string;
  readonly sessionId: string;
  readonly nextStage: WorkflowStage;
  readonly artifactPath?: string;
  readonly promptBundlePath?: string;
  readonly iteration?: number;
  readonly lastValidationIssues?: ReadonlyArray<string>;
};

export type SetArticleStatusRequest = {
  readonly stateFilePath: string;
  readonly sessionId: string;
  readonly articleStatus: ArticleStatus;
  readonly artifactPath: string;
};

export type MarkWorkflowFailureRequest = {
  readonly stateFilePath: string;
  readonly sessionId: string;
  readonly message: string;
};

const decodeWorkflowState = Schema.decodeUnknownEffect(WorkflowStateSchema);

const createEmptyState = (): WorkflowState => ({
  version: 1,
  sessions: {},
});

const allowedTransitions: Readonly<Record<WorkflowStage, ReadonlyArray<WorkflowStage>>> = {
  extracting: ["generating", "failed"],
  generating: ["executing", "failed"],
  executing: ["validating", "failed"],
  validating: ["generating", "reviewing", "complete", "failed"],
  reviewing: ["generating", "complete", "failed"],
  complete: ["generating"],
  failed: ["extracting", "generating", "executing", "validating", "reviewing"],
};

const isActiveStage = (stage: WorkflowStage): stage is ActiveWorkflowStage =>
  stage === "extracting" ||
  stage === "generating" ||
  stage === "executing" ||
  stage === "validating" ||
  stage === "reviewing";

const defaultNextStageForFailure = (state: SessionWorkflowState): ActiveWorkflowStage =>
  state.lastStableStage === "validating" ? "executing" : (state.lastStableStage ?? "extracting");

const readStateFile = (stateFilePath: string): Effect.Effect<WorkflowState, StateError> =>
  Effect.tryPromise({
    try: async () => {
      const content = await readFile(stateFilePath, "utf8");
      return JSON.parse(content) as unknown;
    },
    catch: (cause) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      return new StateError({
        code: message.includes("ENOENT") ? "STATE_READ_FAILED" : "STATE_CORRUPTED",
        message: message.includes("ENOENT")
          ? "Workflow state file does not exist"
          : "Workflow state file is corrupted",
        context: {
          stateFilePath,
          details: { cause: message },
        },
      });
    },
  }).pipe(
    Effect.flatMap((raw) =>
      decodeWorkflowState(raw).pipe(
        Effect.mapError(
          (cause) =>
            new StateError({
              code: "STATE_CORRUPTED",
              message: "Workflow state file could not be decoded",
              context: {
                stateFilePath,
                details: { cause: String(cause) },
              },
            }),
        ),
      ),
    ),
  );

const persistStateFile = (
  stateFilePath: string,
  state: WorkflowState,
): Effect.Effect<void, StateError> =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(dirname(stateFilePath), { recursive: true });
      const tempPath = `${stateFilePath}.tmp`;
      await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
      await rename(tempPath, stateFilePath);
    },
    catch: (cause) =>
      new StateError({
        code: "STATE_WRITE_FAILED",
        message: "Failed to persist workflow state",
        context: {
          stateFilePath,
          details: { cause: String(cause) },
        },
      }),
  });

export class WorkflowStateManager extends ServiceMap.Service<
  WorkflowStateManager,
  {
    readState(stateFilePath: string): Effect.Effect<WorkflowState, StateError>;
    getSessionState(
      stateFilePath: string,
      sessionId: string,
    ): Effect.Effect<Option.Option<SessionWorkflowState>, StateError>;
    initializeSession(
      request: InitializeSessionRequest,
    ): Effect.Effect<SessionWorkflowState, StateError>;
    transition(request: TransitionWorkflowRequest): Effect.Effect<SessionWorkflowState, StateError>;
    setArticleStatus(
      request: SetArticleStatusRequest,
    ): Effect.Effect<SessionWorkflowState, StateError>;
    markFailure(
      request: MarkWorkflowFailureRequest,
    ): Effect.Effect<SessionWorkflowState, StateError>;
    recoverSession(
      stateFilePath: string,
      sessionId: string,
    ): Effect.Effect<WorkflowRecovery, StateError>;
  }
>()("session-mind/WorkflowStateManager") {
  static readonly layer = Layer.effect(WorkflowStateManager)(
    Effect.gen(function* () {
      const stateLock = yield* Semaphore.make(1);
      const withStateLock = stateLock.withPermits(1);

      const readState = Effect.fn("WorkflowStateManager.readState")(function* (
        stateFilePath: string,
      ) {
        return yield* readStateFile(stateFilePath).pipe(
          Effect.catchTag("StateError", (error) =>
            error.code === "STATE_READ_FAILED"
              ? Effect.succeed(createEmptyState())
              : Effect.fail(error),
          ),
        );
      });

      const getSessionState = Effect.fn("WorkflowStateManager.getSessionState")(function* (
        stateFilePath: string,
        sessionId: string,
      ) {
        const state = yield* readState(stateFilePath);
        const sessionState = state.sessions[sessionId];
        return sessionState === undefined ? Option.none() : Option.some(sessionState);
      });

      const initializeSession = Effect.fn("WorkflowStateManager.initializeSession")(function* ({
        stateFilePath,
        sessionId,
        artifactPath,
        articleStatus,
      }: InitializeSessionRequest) {
        return yield* withStateLock(
          Effect.gen(function* () {
            const state = yield* readState(stateFilePath);
            const existing = state.sessions[sessionId];
            if (existing) {
              return existing;
            }

            const sessionState: SessionWorkflowState = {
              sessionId,
              stage: "extracting",
              artifactPath,
              articleStatus: articleStatus ?? "draft",
              iteration: 1,
              updatedAt: Date.now(),
              retryCount: 0,
              lastStableStage: "extracting",
            };

            const nextState: WorkflowState = {
              ...state,
              sessions: {
                ...state.sessions,
                [sessionId]: sessionState,
              },
            };

            yield* persistStateFile(stateFilePath, nextState);
            return sessionState;
          }),
        );
      });

      const transition = Effect.fn("WorkflowStateManager.transition")(function* ({
        stateFilePath,
        sessionId,
        nextStage,
        artifactPath,
        promptBundlePath,
        iteration,
        lastValidationIssues,
      }: TransitionWorkflowRequest) {
        return yield* withStateLock(
          Effect.gen(function* () {
            const state = yield* readState(stateFilePath);
            const current = state.sessions[sessionId];

            if (!current) {
              return yield* new StateError({
                code: "STATE_TRANSITION_INVALID",
                message: "Cannot transition a session without state",
                context: {
                  stateFilePath,
                  sessionId,
                  nextState: nextStage,
                },
              });
            }

            if (!allowedTransitions[current.stage].includes(nextStage)) {
              return yield* new StateError({
                code: "STATE_TRANSITION_INVALID",
                message: "Invalid workflow state transition",
                context: {
                  stateFilePath,
                  sessionId,
                  currentState: current.stage,
                  nextState: nextStage,
                  retryCount: current.retryCount,
                },
              });
            }

            const { lastError: _lastError, ...currentWithoutLastError } = current;
            const nextSessionState: SessionWorkflowState = {
              ...currentWithoutLastError,
              stage: nextStage,
              artifactPath: artifactPath ?? current.artifactPath,
              iteration: iteration ?? current.iteration,
              updatedAt: Date.now(),
              retryCount: nextStage === "complete" ? 0 : current.retryCount,
              ...(isActiveStage(nextStage)
                ? { lastStableStage: nextStage }
                : current.lastStableStage !== undefined
                  ? { lastStableStage: current.lastStableStage }
                  : {}),
              ...(promptBundlePath !== undefined
                ? { promptBundlePath }
                : current.promptBundlePath !== undefined
                  ? { promptBundlePath: current.promptBundlePath }
                  : {}),
              ...(lastValidationIssues !== undefined
                ? { lastValidationIssues: [...lastValidationIssues] }
                : current.lastValidationIssues !== undefined
                  ? { lastValidationIssues: current.lastValidationIssues }
                  : {}),
            };

            const nextStateObject: WorkflowState = {
              ...state,
              sessions: {
                ...state.sessions,
                [sessionId]: nextSessionState,
              },
            };

            yield* persistStateFile(stateFilePath, nextStateObject);
            return nextSessionState;
          }),
        );
      });

      const setArticleStatus = Effect.fn("WorkflowStateManager.setArticleStatus")(function* ({
        stateFilePath,
        sessionId,
        articleStatus,
        artifactPath,
      }: SetArticleStatusRequest) {
        return yield* withStateLock(
          Effect.gen(function* () {
            const state = yield* readState(stateFilePath);
            const current = state.sessions[sessionId];

            if (!current) {
              return yield* new StateError({
                code: "STATE_TRANSITION_INVALID",
                message: "Cannot update article status without session state",
                context: {
                  stateFilePath,
                  sessionId,
                  details: { articleStatus, artifactPath },
                },
              });
            }

            const nextSessionState: SessionWorkflowState = {
              ...current,
              articleStatus,
              artifactPath,
              updatedAt: Date.now(),
            };

            const nextStateObject: WorkflowState = {
              ...state,
              sessions: {
                ...state.sessions,
                [sessionId]: nextSessionState,
              },
            };

            yield* persistStateFile(stateFilePath, nextStateObject);
            return nextSessionState;
          }),
        );
      });

      const markFailure = Effect.fn("WorkflowStateManager.markFailure")(function* ({
        stateFilePath,
        sessionId,
        message,
      }: MarkWorkflowFailureRequest) {
        return yield* withStateLock(
          Effect.gen(function* () {
            const state = yield* readState(stateFilePath);
            const current = state.sessions[sessionId];

            if (!current) {
              return yield* new StateError({
                code: "STATE_TRANSITION_INVALID",
                message: "Cannot fail a session without state",
                context: {
                  stateFilePath,
                  sessionId,
                  nextState: "failed",
                },
              });
            }

            const failedState: SessionWorkflowState = {
              ...current,
              stage: "failed",
              updatedAt: Date.now(),
              retryCount: current.retryCount + 1,
              lastError: message,
            };

            const nextState: WorkflowState = {
              ...state,
              sessions: {
                ...state.sessions,
                [sessionId]: failedState,
              },
            };

            yield* persistStateFile(stateFilePath, nextState);
            return failedState;
          }),
        );
      });

      const recoverSession = Effect.fn("WorkflowStateManager.recoverSession")(function* (
        stateFilePath: string,
        sessionId: string,
      ) {
        const state = yield* readState(stateFilePath);
        const current = state.sessions[sessionId];

        if (!current) {
          return { action: "start" } satisfies WorkflowRecovery;
        }

        if (current.stage === "complete") {
          if (current.articleStatus === "draft") {
            return {
              action: "resume",
              nextStage: "generating",
              state: current,
            } satisfies WorkflowRecovery;
          }

          return {
            action: "complete",
            state: current,
          } satisfies WorkflowRecovery;
        }

        if (current.stage === "failed") {
          if (current.retryCount >= 3) {
            return yield* new StateError({
              code: "STATE_RECOVERY_FAILED",
              message: "Workflow session exceeded maximum recovery attempts",
              context: {
                stateFilePath,
                sessionId,
                currentState: current.stage,
                retryCount: current.retryCount,
              },
            });
          }

          return {
            action: "resume",
            nextStage: defaultNextStageForFailure(current),
            state: current,
          } satisfies WorkflowRecovery;
        }

        return {
          action: "resume",
          nextStage: current.stage,
          state: current,
        } satisfies WorkflowRecovery;
      });

      return WorkflowStateManager.of({
        readState,
        getSessionState,
        initializeSession,
        transition,
        setArticleStatus,
        markFailure,
        recoverSession,
      });
    }),
  );
}
