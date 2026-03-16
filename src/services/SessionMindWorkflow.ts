import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Layer, ServiceMap } from "effect";
import * as Console from "effect/Console";
import type { ExtractedConversation, PromptBundle } from "../domain/Session.ts";
import { SessionMindOutputPaths } from "../domain/SubprocessProtocol.ts";
import {
  ExtractionError,
  PromptGenerationError,
  ValidationError,
} from "../domain/SessionMindErrors.ts";
import type { SessionMindError } from "../domain/SessionMindErrors.ts";
import { ArtifactValidator, type ArtifactValidationResult } from "./ArtifactValidator.ts";
import { SubprocessSpawner, type SpawnSubprocessResult } from "./SubprocessSpawner.ts";
import {
  WorkflowStateManager,
  type ActiveWorkflowStage,
  type SessionWorkflowState,
} from "./WorkflowStateManager.ts";
import { WorkflowSessionExtractor } from "./WorkflowSessionExtractor.ts";
import { WorkflowReviewer } from "./WorkflowReviewer.ts";
import { resolveArticleArtifactPath } from "./ArticleManager.ts";
import type { WriterRevisionContext } from "./WriterTaskBuilder.ts";
import { WritingBriefComposer } from "./WritingBriefComposer.ts";

export type RunWorkflowRequest = {
  readonly sessionId: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly reviewCommand?: string;
  readonly reviewArgs?: ReadonlyArray<string>;
  readonly workdir: string;
  readonly cwd?: string;
  readonly outputDir?: string;
  readonly timeoutMs?: number;
  readonly minimumArtifactLength?: number;
  readonly stdioMode?: "capture" | "foreground";
  readonly maxIterations?: number;
};

export type SessionMindWorkflowResult = {
  readonly sessionId: string;
  readonly artifactPath: string;
  readonly promptBundle: PromptBundle;
  readonly subprocess: SpawnSubprocessResult;
};

const workflowPathsFor = (
  workdir: string,
  sessionId: string,
  outputDir = join(workdir, SessionMindOutputPaths.workflowRoot),
) => {
  return {
    outputDir,
    stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
    artifactPath: resolveArticleArtifactPath(outputDir, "draft", sessionId),
  };
};

const defaultMaxIterations = 3;

const summarizeValidationIssues = (validation: ArtifactValidationResult): ReadonlyArray<string> =>
  validation.issues.map((issue) => {
    switch (issue.code) {
      case "content-too-short":
        return `${issue.message} Actual length: ${issue.actualLength ?? 0}.`;
      case "invalid-markdown":
        return issue.line === undefined ? issue.message : `${issue.message} Line: ${issue.line}.`;
      default:
        return issue.message;
    }
  });

const loadPreviousDraft = (artifactPath: string): Effect.Effect<string | null> =>
  Effect.tryPromise({
    try: () => readFile(artifactPath, "utf8"),
    catch: () => null,
  }).pipe(Effect.catch(() => Effect.succeed(null)));

export class SessionMindWorkflow extends ServiceMap.Service<
  SessionMindWorkflow,
  {
    run(request: RunWorkflowRequest): Effect.Effect<SessionMindWorkflowResult, SessionMindError>;
  }
>()("session-mind/SessionMindWorkflow") {
  static readonly layer = Layer.effect(SessionMindWorkflow)(
    Effect.gen(function* () {
      const extractor = yield* WorkflowSessionExtractor;
      const composer = yield* WritingBriefComposer;
      const spawner = yield* SubprocessSpawner;
      const validator = yield* ArtifactValidator;
      const stateManager = yield* WorkflowStateManager;
      const reviewer = yield* WorkflowReviewer;

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

      const makeValidationError = (
        sessionId: string,
        validation: ArtifactValidationResult,
      ): ValidationError => {
        const primaryIssue = validation.issues[0];
        const code =
          primaryIssue?.code === "file-not-found"
            ? "ARTIFACT_NOT_FOUND"
            : primaryIssue?.code === "empty-content"
              ? "ARTIFACT_EMPTY"
              : primaryIssue?.code === "content-too-short"
                ? "ARTIFACT_TOO_SHORT"
                : primaryIssue?.code === "invalid-markdown"
                  ? "ARTIFACT_INVALID_FORMAT"
                  : "ARTIFACT_CHECK_FAILED";

        return new ValidationError({
          code,
          message: primaryIssue?.message ?? "Generated artifact failed validation",
          context: {
            artifactPath: validation.artifactPath,
            sessionId,
            ...(primaryIssue !== undefined ? { rule: primaryIssue.code } : {}),
            ...(primaryIssue?.actualLength !== undefined
              ? { actualLength: primaryIssue.actualLength }
              : { actualLength: validation.contentLength }),
            ...(primaryIssue?.expectedMinimumLength !== undefined
              ? { minimumLength: primaryIssue.expectedMinimumLength }
              : {}),
            details: {
              issues: validation.issues.map((issue) => ({
                code: issue.code,
                message: issue.message,
              })),
            },
          },
        });
      };

      const run = Effect.fn("SessionMindWorkflow.run")(function* ({
        sessionId,
        command,
        args = [],
        reviewCommand = command,
        reviewArgs = args,
        workdir,
        cwd = workdir,
        outputDir,
        timeoutMs,
        minimumArtifactLength,
        stdioMode,
        maxIterations = defaultMaxIterations,
      }: RunWorkflowRequest) {
        const paths = workflowPathsFor(workdir, sessionId, outputDir);
        const recovery = yield* stateManager.recoverSession(paths.stateFilePath, sessionId);

        if (recovery.action === "complete") {
          if (recovery.state.articleStatus === "published") {
            return yield* new ValidationError({
              code: "ARTIFACT_CHECK_FAILED",
              message:
                "Published articles are immutable. Move the article back to draft before running write again.",
              context: {
                artifactPath: recovery.state.artifactPath,
                sessionId,
                details: {
                  articleStatus: recovery.state.articleStatus,
                },
              },
            });
          }

          yield* Console.log(
            `Workflow already complete for ${sessionId}; reusing ${recovery.state.artifactPath}`,
          );
          const promptBundle: PromptBundle = {
            topicHint: `Recovered ${sessionId}`,
            writingBrief: "",
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
          yield* Console.log(`Starting article workflow for ${sessionId}`);
          yield* stateManager.initializeSession({
            stateFilePath: paths.stateFilePath,
            sessionId,
            artifactPath: paths.artifactPath,
          });
        } else if (recovery.action === "resume") {
          yield* Console.log(
            `Resuming article workflow for ${sessionId} from stage ${recovery.nextStage}`,
          );
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

            yield* Console.log(`Extracting conversation for ${sessionId}`);
            const extracted = yield* extractConversation(sessionId);

            yield* Console.log(
              `Composing prompt bundle from ${extracted.turns.length} turns for ${sessionId}`,
            );
            const promptBundle = yield* composePrompt(extracted);
            const buildRevisionContext = ({
              artifactPath,
              issues,
            }: {
              readonly artifactPath: string;
              readonly issues: ReadonlyArray<string>;
            }): Effect.Effect<WriterRevisionContext> =>
              Effect.gen(function* () {
                return {
                  validationIssues: issues,
                  previousArtifactPath: artifactPath,
                } satisfies WriterRevisionContext;
              });

            const reviewValidatedArtifact = ({
              iteration,
              subprocess,
              alreadyReviewing = false,
            }: {
              readonly iteration: number;
              readonly subprocess: SpawnSubprocessResult;
              readonly alreadyReviewing?: boolean;
            }): Effect.Effect<SessionMindWorkflowResult, SessionMindError> =>
              Effect.gen(function* () {
                if (!alreadyReviewing) {
                  yield* stateManager.transition({
                    stateFilePath: paths.stateFilePath,
                    sessionId,
                    nextStage: "reviewing",
                    artifactPath: subprocess.artifactPath,
                    promptBundlePath: subprocess.promptBundlePath,
                    iteration,
                  });
                }

                const articleContent = (yield* loadPreviousDraft(subprocess.artifactPath)) ?? "";
                const reviewOutcome = yield* reviewer.review({
                  sessionId,
                  artifactPath: subprocess.artifactPath,
                  articleContent,
                  command: reviewCommand,
                  args: reviewArgs,
                  cwd,
                  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                });

                if (reviewOutcome.status === "completed") {
                  yield* stateManager.transition({
                    stateFilePath: paths.stateFilePath,
                    sessionId,
                    nextStage: "complete",
                    artifactPath: subprocess.artifactPath,
                    promptBundlePath: subprocess.promptBundlePath,
                    iteration,
                  });
                  yield* Console.log(`Workflow complete for ${sessionId}`);

                  return {
                    sessionId,
                    artifactPath: subprocess.artifactPath,
                    promptBundle,
                    subprocess,
                  } satisfies SessionMindWorkflowResult;
                }

                const nextIteration = iteration + 1;
                const reviewNotes = [`Reviewer revision brief: ${reviewOutcome.revisionBrief}`];
                yield* Console.log(
                  `Reviewer requested another writer pass for ${sessionId}; starting attempt ${nextIteration}`,
                );
                yield* stateManager.transition({
                  stateFilePath: paths.stateFilePath,
                  sessionId,
                  nextStage: "generating",
                  artifactPath: subprocess.artifactPath,
                  promptBundlePath: subprocess.promptBundlePath,
                  iteration: nextIteration,
                  lastValidationIssues: reviewNotes,
                });

                const nextRevision = yield* buildRevisionContext({
                  artifactPath: subprocess.artifactPath,
                  issues: reviewNotes,
                });

                return yield* runIteration({
                  iteration: nextIteration,
                  stage: "generating",
                  revision: nextRevision,
                });
              });

            const runIteration = ({
              iteration,
              stage,
              revision,
              existingSubprocess,
            }: {
              readonly iteration: number;
              readonly stage: ActiveWorkflowStage;
              readonly revision?: WriterRevisionContext;
              readonly existingSubprocess?: SpawnSubprocessResult;
            }): Effect.Effect<SessionMindWorkflowResult, SessionMindError> =>
              Effect.gen(function* () {
                let currentStage = stage;

                if (currentStage === "extracting") {
                  yield* stateManager.transition({
                    stateFilePath: paths.stateFilePath,
                    sessionId,
                    nextStage: "generating",
                    artifactPath: paths.artifactPath,
                    iteration,
                  });
                  currentStage = "generating";
                }

                if (currentStage === "generating") {
                  yield* stateManager.transition({
                    stateFilePath: paths.stateFilePath,
                    sessionId,
                    nextStage: "executing",
                    artifactPath: paths.artifactPath,
                    iteration,
                  });
                  currentStage = "executing";
                }

                let subprocess: SpawnSubprocessResult;

                if (currentStage === "validating" && existingSubprocess !== undefined) {
                  yield* Console.log(`Skipping writer subprocess and re-validating ${sessionId}`);
                  subprocess = existingSubprocess;
                } else {
                  yield* Console.log(
                    `Launching writer subprocess "${command}" for ${sessionId} (attempt ${iteration}/${maxIterations})`,
                  );
                  subprocess = yield* spawner.spawn({
                    command,
                    args,
                    cwd,
                    sessionId,
                    promptBundle,
                    outputDir: paths.outputDir,
                    iteration,
                    ...(revision !== undefined ? { revision } : {}),
                    ...(stdioMode !== undefined ? { stdioMode } : {}),
                    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
                  });
                  yield* Console.log(
                    `Writer subprocess finished for ${sessionId}; validating ${subprocess.artifactPath}`,
                  );
                  yield* stateManager.transition({
                    stateFilePath: paths.stateFilePath,
                    sessionId,
                    nextStage: "validating",
                    artifactPath: subprocess.artifactPath,
                    promptBundlePath: subprocess.promptBundlePath,
                    iteration,
                  });
                }

                const validation = yield* validator.validate(
                  subprocess.artifactPath,
                  minimumArtifactLength !== undefined
                    ? { minimumLength: minimumArtifactLength }
                    : undefined,
                );

                if (validation.isValid) {
                  yield* Console.log(`Artifact validation passed for ${sessionId}`);
                  return yield* reviewValidatedArtifact({
                    iteration,
                    subprocess,
                  });
                }

                const validationIssues = summarizeValidationIssues(validation);
                if (iteration >= maxIterations) {
                  yield* Console.log(
                    `Artifact validation failed for ${sessionId} after ${iteration} attempts`,
                  );
                  return yield* makeValidationError(sessionId, validation);
                }

                const nextIteration = iteration + 1;
                yield* Console.log(
                  `Artifact validation failed for ${sessionId}; starting revision attempt ${nextIteration}/${maxIterations}`,
                );
                yield* stateManager.transition({
                  stateFilePath: paths.stateFilePath,
                  sessionId,
                  nextStage: "generating",
                  artifactPath: subprocess.artifactPath,
                  promptBundlePath: subprocess.promptBundlePath,
                  iteration: nextIteration,
                  lastValidationIssues: validationIssues,
                });

                const nextRevision = yield* buildRevisionContext({
                  artifactPath: subprocess.artifactPath,
                  issues: validationIssues,
                });

                return yield* runIteration({
                  iteration: nextIteration,
                  stage: "generating",
                  revision: nextRevision,
                });
              });

            const iteration = recoveredState?.iteration ?? 1;
            const isReopeningCompletedDraft =
              recoveredState?.stage === "complete" && recoveredState.articleStatus === "draft";
            const effectiveIteration = isReopeningCompletedDraft ? iteration + 1 : iteration;
            const initialRevision = isReopeningCompletedDraft
              ? yield* buildRevisionContext({
                  artifactPath: recoveredState.artifactPath,
                  issues: ["Refine the existing draft and overwrite it in place."],
                })
              : iteration > 1 && recoveredState?.lastValidationIssues !== undefined
                ? yield* buildRevisionContext({
                    artifactPath: recoveredState.artifactPath,
                    issues: recoveredState.lastValidationIssues,
                  })
                : undefined;
            const existingSubprocess =
              activeStage === "validating" || activeStage === "reviewing"
                ? {
                    sessionId,
                    artifactPath: recoveredState?.artifactPath ?? paths.artifactPath,
                    promptBundlePath: recoveredState?.promptBundlePath ?? "",
                    exitCode: 0,
                    stdout: "",
                    stderr: "",
                  }
                : undefined;

            if (activeStage === "reviewing" && existingSubprocess !== undefined) {
              return yield* reviewValidatedArtifact({
                iteration: effectiveIteration,
                subprocess: existingSubprocess,
                alreadyReviewing: true,
              });
            }

            if (isReopeningCompletedDraft) {
              yield* Console.log(
                `Reopening draft article workflow for ${sessionId}; starting attempt ${effectiveIteration}`,
              );
              yield* stateManager.transition({
                stateFilePath: paths.stateFilePath,
                sessionId,
                nextStage: "generating",
                artifactPath: recoveredState.artifactPath,
                ...(recoveredState?.promptBundlePath !== undefined
                  ? { promptBundlePath: recoveredState.promptBundlePath }
                  : {}),
                iteration: effectiveIteration,
                lastValidationIssues: ["Refine the existing draft and overwrite it in place."],
              });
            }

            return yield* runIteration({
              iteration: effectiveIteration,
              stage: activeStage,
              ...(initialRevision !== undefined ? { revision: initialRevision } : {}),
              ...(existingSubprocess !== undefined ? { existingSubprocess } : {}),
            });
          });

        return yield* Effect.catch(
          workflowEffect,
          (cause: SessionMindError): Effect.Effect<never, SessionMindError> =>
            stateManager
              .markFailure({
                stateFilePath: paths.stateFilePath,
                sessionId,
                message: cause.message,
              })
              .pipe(Effect.flatMap(() => Effect.fail(cause))),
        );
      });

      return SessionMindWorkflow.of({ run });
    }),
  );
}
