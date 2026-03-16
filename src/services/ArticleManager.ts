import { dirname, join } from "node:path";
import { Effect, FileSystem, Layer, Option, ServiceMap } from "effect";
import { type ArticleStatus } from "../domain/Article.ts";
import { parseSessionIdentifier } from "../domain/Session.ts";
import { SessionMindOutputPaths } from "../domain/SubprocessProtocol.ts";
import { StateError } from "../domain/SessionMindErrors.ts";
import { WorkflowStateManager } from "./WorkflowStateManager.ts";

export type ArticleRecord = {
  readonly sessionId: string;
  readonly articleStatus: ArticleStatus;
  readonly artifactPath: string;
  readonly stage: string;
};

export type UpdateArticleStatusRequest = {
  readonly outputDir: string;
  readonly sessionId: string;
  readonly nextStatus: ArticleStatus;
};

export const resolveArticleArtifactPath = (
  outputDir: string,
  articleStatus: ArticleStatus,
  sessionId: string,
) => {
  const identifier = parseSessionIdentifier(sessionId);
  return join(
    outputDir,
    articleStatus === "draft"
      ? SessionMindOutputPaths.draftsDirectory
      : SessionMindOutputPaths.publishedDirectory,
    identifier.source,
    `${identifier.nativeId}.md`,
  );
};

const stateFilePathFor = (outputDir: string) => join(outputDir, SessionMindOutputPaths.stateFile);

export class ArticleManager extends ServiceMap.Service<
  ArticleManager,
  {
    getArticle(outputDir: string, sessionId: string): Effect.Effect<ArticleRecord, StateError>;
    updateArticleStatus(
      request: UpdateArticleStatusRequest,
    ): Effect.Effect<ArticleRecord, StateError>;
  }
>()("session-mind/ArticleManager") {
  static readonly layer = Layer.effect(ArticleManager)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateManager = yield* WorkflowStateManager;

      const getArticle = Effect.fn("ArticleManager.getArticle")(function* (
        outputDir: string,
        sessionId: string,
      ) {
        const sessionState = yield* stateManager.getSessionState(
          stateFilePathFor(outputDir),
          sessionId,
        );

        if (Option.isNone(sessionState)) {
          return yield* new StateError({
            code: "STATE_TRANSITION_INVALID",
            message: "No article workflow state exists for this session id",
            context: {
              stateFilePath: stateFilePathFor(outputDir),
              sessionId,
            },
          });
        }

        return {
          sessionId,
          articleStatus: sessionState.value.articleStatus,
          artifactPath: sessionState.value.artifactPath,
          stage: sessionState.value.stage,
        } satisfies ArticleRecord;
      });

      const updateArticleStatus = Effect.fn("ArticleManager.updateArticleStatus")(function* ({
        outputDir,
        sessionId,
        nextStatus,
      }: UpdateArticleStatusRequest) {
        const current = yield* getArticle(outputDir, sessionId);
        if (current.articleStatus === nextStatus) {
          return current;
        }

        if (nextStatus === "published" && current.stage !== "complete") {
          return yield* new StateError({
            code: "STATE_TRANSITION_INVALID",
            message: "Only completed draft articles can be published",
            context: {
              stateFilePath: stateFilePathFor(outputDir),
              sessionId,
              currentState: current.stage,
              nextState: "published",
            },
          });
        }

        const nextArtifactPath = resolveArticleArtifactPath(outputDir, nextStatus, sessionId);

        const artifactExists = yield* fs.exists(current.artifactPath).pipe(
          Effect.mapError(
            (cause) =>
              new StateError({
                code: "STATE_TRANSITION_INVALID",
                message: "Failed while checking the current article file",
                context: {
                  stateFilePath: stateFilePathFor(outputDir),
                  sessionId,
                  details: { cause: String(cause), artifactPath: current.artifactPath },
                },
              }),
          ),
        );

        if (!artifactExists) {
          return yield* new StateError({
            code: "STATE_TRANSITION_INVALID",
            message: "The current article file does not exist",
            context: {
              stateFilePath: stateFilePathFor(outputDir),
              sessionId,
              details: { artifactPath: current.artifactPath },
            },
          });
        }

        const nextDirectory = dirname(nextArtifactPath);

        yield* fs.makeDirectory(nextDirectory, { recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new StateError({
                code: "STATE_WRITE_FAILED",
                message: "Failed to prepare the target article directory",
                context: {
                  stateFilePath: stateFilePathFor(outputDir),
                  sessionId,
                  details: { cause: String(cause), artifactPath: nextArtifactPath },
                },
              }),
          ),
        );

        yield* fs.remove(nextArtifactPath, { force: true }).pipe(Effect.catch(() => Effect.void));
        yield* fs.rename(current.artifactPath, nextArtifactPath).pipe(
          Effect.mapError(
            (cause) =>
              new StateError({
                code: "STATE_WRITE_FAILED",
                message: "Failed to move the article to the requested status directory",
                context: {
                  stateFilePath: stateFilePathFor(outputDir),
                  sessionId,
                  details: {
                    cause: String(cause),
                    from: current.artifactPath,
                    to: nextArtifactPath,
                  },
                },
              }),
          ),
        );

        const nextState = yield* stateManager
          .setArticleStatus({
            stateFilePath: stateFilePathFor(outputDir),
            sessionId,
            articleStatus: nextStatus,
            artifactPath: nextArtifactPath,
          })
          .pipe(
            Effect.catchTag("StateError", (cause) =>
              fs.rename(nextArtifactPath, current.artifactPath).pipe(
                Effect.mapError(
                  (rollbackCause) =>
                    new StateError({
                      code: "STATE_WRITE_FAILED",
                      message:
                        "Failed to persist article status after moving the article, and rollback also failed",
                      context: {
                        stateFilePath: stateFilePathFor(outputDir),
                        sessionId,
                        details: {
                          cause: String(cause),
                          rollbackCause: String(rollbackCause),
                          from: current.artifactPath,
                          to: nextArtifactPath,
                        },
                      },
                    }),
                ),
                Effect.flatMap(() =>
                  Effect.fail(
                    new StateError({
                      code: "STATE_WRITE_FAILED",
                      message:
                        "Failed to persist article status after moving the article. The file move was rolled back.",
                      context: {
                        stateFilePath: stateFilePathFor(outputDir),
                        sessionId,
                        details: {
                          cause: String(cause),
                          from: current.artifactPath,
                          to: nextArtifactPath,
                        },
                      },
                    }),
                  ),
                ),
              ),
            ),
          );

        return {
          sessionId,
          articleStatus: nextState.articleStatus,
          artifactPath: nextState.artifactPath,
          stage: nextState.stage,
        } satisfies ArticleRecord;
      });

      return ArticleManager.of({
        getArticle,
        updateArticleStatus,
      });
    }),
  );
}
