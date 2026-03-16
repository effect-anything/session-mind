import { join } from "node:path";
import { Effect, Layer, ServiceMap } from "effect";
import type { ExtractedConversation, PromptBundle } from "../domain/Session";
import { SessionMindOutputPaths } from "../domain/SubprocessProtocol";
import {
  ExtractionError,
  PromptGenerationError,
} from "../domain/SessionMindErrors";
import type { SessionMindError } from "../domain/SessionMindErrors";
import { PromptComposer } from "./PromptComposer";
import { ArtifactValidator } from "./ArtifactValidator";
import { SubprocessSpawner, type SpawnSubprocessResult } from "./SubprocessSpawner";
import {
  WorkflowStateManager,
  type ActiveWorkflowStage,
  type SessionWorkflowState,
} from "./WorkflowStateManager";
import { WorkflowSessionExtractor } from "./WorkflowSessionExtractor";

export type RunWorkflowRequest = {
  readonly sessionId: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly workdir: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly minimumArtifactLength?: number;
};

export type SessionMindWorkflowResult = {
  readonly sessionId: string;
  readonly artifactPath: string;
  readonly promptBundle: PromptBundle;
  readonly subprocess: SpawnSubprocessResult;
};

const workflowPathsFor = (workdir: string, sessionId: string) => {
  const outputDir = join(workdir, SessionMindOutputPaths.workflowRoot);
  return {
    outputDir,
    stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
    artifactPath: join(
      outputDir,
      SessionMindOutputPaths.articlesDirectory,
      `${sessionId}.md`,
    ),
  };
};

export class SessionMindWorkflow extends ServiceMap.Service<
  SessionMindWorkflow,
  {
    run(
      request: RunWorkflowRequest,
    ): Effect.Effect<SessionMindWorkflowResult, SessionMindError>;
  }
>()("session-mind/SessionMindWorkflow") {
  static readonly layer = Layer.effect(SessionMindWorkflow)(
    Effect.gen(function* () {
      const extractor = yield* WorkflowSessionExtractor;
      const composer = yield* PromptComposer;
      const spawner = yield* SubprocessSpawner;
      const validator = yield* ArtifactValidator;
      const stateManager = yield* WorkflowStateManager;

      const extractConversation = (
        sessionId: string,
      ): Effect.Effect<ExtractedConversation, ExtractionError> =>
        extractor.extract(sessionId).pipe(
          Effect.mapError(
            (cause) =>
              new ExtractionError({
                code: "SESSION_READ_FAILED",
                message: "Failed to extract session conversation",
                context: {
                  sessionId,
                  details: { cause: String(cause) },
                },
              }),
          ),
        );

      const composePrompt = (
        extracted: ExtractedConversation,
      ): Effect.Effect<PromptBundle, PromptGenerationError> => {
        if (extracted.turns.length === 0) {
          return Effect.fail(
            new PromptGenerationError({
              code: "EMPTY_EXTRACTION_INPUT",
              message: "Cannot generate a prompt from an empty extraction",
              context: {
                sourceSessionIds: [extracted.session.id],
              },
            }),
          );
        }

        return composer.compose([extracted]).pipe(
          Effect.mapError(
            (cause) =>
              new PromptGenerationError({
                code: "PROMPT_TEMPLATE_RENDER_FAILED",
                message: "Failed to compose prompt bundle",
                context: {
                  sourceSessionIds: [extracted.session.id],
                  details: { cause: String(cause) },
                },
              }),
          ),
        );
      };

      const run = Effect.fn("SessionMindWorkflow.run")(function* ({
        sessionId,
        command,
        args = [],
        workdir,
        cwd = workdir,
        timeoutMs,
        minimumArtifactLength,
      }: RunWorkflowRequest) {
        const paths = workflowPathsFor(workdir, sessionId);
        const recovery = yield* stateManager.recoverSession(paths.stateFilePath, sessionId);

        if (recovery.action === "complete") {
          const promptBundle: PromptBundle = {
            topicHint: `Recovered ${sessionId}`,
            prompt: "",
            sourceSessionIds: [sessionId],
            generatedAt: recovery.state.updatedAt,
            extracted: [],
          };

          return {
            sessionId,
            artifactPath: recovery.state.artifactPath,
            promptBundle,
            subprocess: {
              sessionId,
              artifactPath: recovery.state.artifactPath,
              promptBundlePath: recovery.state.promptBundlePath ?? "",
              exitCode: 0,
              stdout: "",
              stderr: "",
            },
          } satisfies SessionMindWorkflowResult;
        }

        if (recovery.action === "start") {
          yield* stateManager.initializeSession({
            stateFilePath: paths.stateFilePath,
            sessionId,
            artifactPath: paths.artifactPath,
          });
        }

        const activeStage: ActiveWorkflowStage =
          recovery.action === "resume" ? recovery.nextStage : "extracting";

        const recoveredState: SessionWorkflowState | undefined =
          recovery.action === "resume" ? recovery.state : undefined;

        const workflowEffect: Effect.Effect<SessionMindWorkflowResult, SessionMindError> =
          Effect.gen(function* () {
          if (recoveredState?.stage === "failed") {
            yield* stateManager.transition({
              stateFilePath: paths.stateFilePath,
              sessionId,
              nextStage: activeStage,
              artifactPath: recoveredState.artifactPath,
              ...(recoveredState.promptBundlePath !== undefined
                ? { promptBundlePath: recoveredState.promptBundlePath }
                : {}),
            });
          }

          const extracted = yield* extractConversation(sessionId);
          if (activeStage === "extracting") {
            yield* stateManager.transition({
              stateFilePath: paths.stateFilePath,
              sessionId,
              nextStage: "generating",
              artifactPath: paths.artifactPath,
            });
          }

          const promptBundle = yield* composePrompt(extracted);
          let subprocess: SpawnSubprocessResult;

          if (activeStage === "extracting" || activeStage === "generating") {
            yield* stateManager.transition({
              stateFilePath: paths.stateFilePath,
              sessionId,
              nextStage: "executing",
              artifactPath: paths.artifactPath,
            });
          }

          if (activeStage === "validating") {
            subprocess = {
              sessionId,
              artifactPath: recoveredState?.artifactPath ?? paths.artifactPath,
              promptBundlePath: recoveredState?.promptBundlePath ?? "",
              exitCode: 0,
              stdout: "",
              stderr: "",
            };
          } else {
            subprocess = yield* spawner.spawn({
              command,
              args,
              cwd,
              sessionId,
              promptBundle,
              outputDir: paths.outputDir,
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            });
            yield* stateManager.transition({
              stateFilePath: paths.stateFilePath,
              sessionId,
              nextStage: "validating",
              artifactPath: subprocess.artifactPath,
              promptBundlePath: subprocess.promptBundlePath,
            });
          }

          yield* validator.validate(
            subprocess.artifactPath,
            minimumArtifactLength !== undefined
              ? { minimumLength: minimumArtifactLength }
              : undefined,
          );

          yield* stateManager.transition({
            stateFilePath: paths.stateFilePath,
            sessionId,
            nextStage: "complete",
            artifactPath: subprocess.artifactPath,
            promptBundlePath: subprocess.promptBundlePath,
          });

          return {
            sessionId,
            artifactPath: subprocess.artifactPath,
            promptBundle,
            subprocess,
          } satisfies SessionMindWorkflowResult;
          });

        return yield* Effect.catch(
          workflowEffect,
          (cause: SessionMindError): Effect.Effect<never, SessionMindError> =>
            stateManager.markFailure({
              stateFilePath: paths.stateFilePath,
              sessionId,
              message: cause.message,
            }).pipe(Effect.flatMap(() => Effect.fail(cause))),
        );
      });

      return SessionMindWorkflow.of({ run });
    }),
  );
}
