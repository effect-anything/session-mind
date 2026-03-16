import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMindOutputPaths } from "../src/domain/SubprocessProtocol.ts";
import { ArticleManager } from "../src/services/ArticleManager.ts";
import { WorkflowStateManager } from "../src/services/WorkflowStateManager.ts";

const tempDirectories: Array<string> = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-mind-article-manager-"));
  tempDirectories.push(directory);
  return directory;
};

const runWithArticleManager = <A, E>(
  effect: Effect.Effect<A, E, ArticleManager | WorkflowStateManager>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          WorkflowStateManager.layer,
          ArticleManager.layer.pipe(
            Layer.provide(WorkflowStateManager.layer),
            Layer.provide(NodeFileSystem.layer),
          ),
        ),
      ),
    ),
  );

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ArticleManager", () => {
  it("moves a completed draft into the published directory and updates state", async () => {
    await runWithArticleManager(
      Effect.gen(function* () {
        const manager = yield* ArticleManager;
        const workflowState = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const outputDir = join(rootDirectory, SessionMindOutputPaths.workflowRoot);
        const draftPath = join(
          outputDir,
          SessionMindOutputPaths.draftsDirectory,
          "opencode",
          "session-1.md",
        );

        yield* Effect.tryPromise(() =>
          mkdir(join(outputDir, SessionMindOutputPaths.draftsDirectory, "opencode"), {
            recursive: true,
          }),
        );
        yield* Effect.tryPromise(() => writeFile(draftPath, "# draft", "utf8"));

        yield* workflowState.initializeSession({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-1",
          artifactPath: draftPath,
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-1",
          nextStage: "generating",
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-1",
          nextStage: "executing",
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-1",
          nextStage: "validating",
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-1",
          nextStage: "complete",
        });

        const article = yield* manager.updateArticleStatus({
          outputDir,
          sessionId: "session-1",
          nextStatus: "published",
        });

        expect(article.articleStatus).toBe("published");
        expect(article.artifactPath).toBe(
          join(outputDir, SessionMindOutputPaths.publishedDirectory, "opencode", "session-1.md"),
        );
        expect(yield* Effect.tryPromise(() => readFile(article.artifactPath, "utf8"))).toBe(
          "# draft",
        );
      }),
    );
  });

  it("moves a published article back to draft so write can reopen it", async () => {
    await runWithArticleManager(
      Effect.gen(function* () {
        const manager = yield* ArticleManager;
        const workflowState = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const outputDir = join(rootDirectory, SessionMindOutputPaths.workflowRoot);
        const publishedPath = join(
          outputDir,
          SessionMindOutputPaths.publishedDirectory,
          "opencode",
          "session-2.md",
        );

        yield* Effect.tryPromise(() =>
          mkdir(join(outputDir, SessionMindOutputPaths.publishedDirectory, "opencode"), {
            recursive: true,
          }),
        );
        yield* Effect.tryPromise(() => writeFile(publishedPath, "# published", "utf8"));

        yield* workflowState.initializeSession({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-2",
          artifactPath: join(
            outputDir,
            SessionMindOutputPaths.draftsDirectory,
            "opencode",
            "session-2.md",
          ),
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-2",
          nextStage: "generating",
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-2",
          nextStage: "executing",
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-2",
          nextStage: "validating",
        });
        yield* workflowState.transition({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-2",
          nextStage: "complete",
        });
        yield* workflowState.setArticleStatus({
          stateFilePath: join(outputDir, SessionMindOutputPaths.stateFile),
          sessionId: "session-2",
          articleStatus: "published",
          artifactPath: publishedPath,
        });

        const article = yield* manager.updateArticleStatus({
          outputDir,
          sessionId: "session-2",
          nextStatus: "draft",
        });

        expect(article.articleStatus).toBe("draft");
        expect(article.artifactPath).toBe(
          join(outputDir, SessionMindOutputPaths.draftsDirectory, "opencode", "session-2.md"),
        );
        expect(yield* Effect.tryPromise(() => readFile(article.artifactPath, "utf8"))).toBe(
          "# published",
        );
      }),
    );
  });
});
