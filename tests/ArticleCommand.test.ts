import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Layer, Stdio } from "effect";
import * as TestConsole from "effect/testing/TestConsole";
import * as Terminal from "effect/Terminal";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { describe, expect, it } from "vitest";
import { articleCommand } from "../src/commands/articleCommand.ts";
import { ArticleManager, type ArticleRecord } from "../src/services/ArticleManager.ts";

const createHarness = () => {
  const calls: Array<
    | { readonly type: "status"; readonly outputDir: string; readonly sessionId: string }
    | {
        readonly type: "update";
        readonly outputDir: string;
        readonly sessionId: string;
        readonly nextStatus: "draft" | "published";
      }
  > = [];

  const baseRecord = (
    sessionId: string,
    articleStatus: "draft" | "published",
    outputDir: string,
  ): ArticleRecord => ({
    sessionId,
    articleStatus,
    stage: "complete",
    artifactPath: join(
      outputDir,
      articleStatus === "draft" ? "drafts" : "published",
      "opencode",
      `${sessionId}.md`,
    ),
  });

  const articleLayer = Layer.succeed(
    ArticleManager,
    ArticleManager.of({
      getArticle: (outputDir, sessionId) => {
        calls.push({ type: "status", outputDir, sessionId });
        return Effect.succeed(baseRecord(sessionId, "draft", outputDir));
      },
      updateArticleStatus: ({ outputDir, sessionId, nextStatus }) => {
        calls.push({ type: "update", outputDir, sessionId, nextStatus });
        return Effect.succeed(baseRecord(sessionId, nextStatus, outputDir));
      },
    }),
  );

  const rootCommand = Command.make("session-mind").pipe(Command.withSubcommands([articleCommand]));
  const terminalLayer = Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: () => Effect.void,
      readInput: Effect.die("Not implemented"),
      readLine: Effect.succeed(""),
    }),
  );

  const testLayer = Layer.mergeAll(
    articleLayer,
    NodeFileSystem.layer,
    NodePath.layer,
    TestConsole.layer,
    terminalLayer,
    CliOutput.layer(CliOutput.defaultFormatter({ colors: false })),
    Layer.succeed(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("Not implemented")),
    ),
    Stdio.layerTest({}),
  );

  return {
    calls,
    run: (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const runCommand = Command.runWith(rootCommand, { version: "0.1.0" });
        yield* runCommand(args);
        return yield* TestConsole.logLines;
      }).pipe(Effect.provide(testLayer)),
  };
};

describe("articleCommand", () => {
  it("shows the current article status and path", async () => {
    const harness = createHarness();
    const outputDir = "/tmp/session-mind";

    const logs = await Effect.runPromise(
      harness.run(["article", "status", "session-1", "--output-dir", outputDir]),
    );

    expect(harness.calls).toEqual([{ type: "status", outputDir, sessionId: "session-1" }]);
    expect(logs.join("\n")).toContain(
      "session-1: draft (complete) -> /tmp/session-mind/drafts/opencode/session-1.md",
    );
  });

  it("publishes a completed draft article", async () => {
    const harness = createHarness();
    const outputDir = "/tmp/session-mind";

    const logs = await Effect.runPromise(
      harness.run(["article", "publish", "session-1", "--output-dir", outputDir]),
    );

    expect(harness.calls).toEqual([
      { type: "update", outputDir, sessionId: "session-1", nextStatus: "published" },
    ]);
    expect(logs.join("\n")).toContain(
      "Published article for session-1 at /tmp/session-mind/published/opencode/session-1.md",
    );
  });

  it("moves a published article back to draft", async () => {
    const harness = createHarness();
    const outputDir = "/tmp/session-mind";

    const logs = await Effect.runPromise(
      harness.run(["article", "draft", "session-1", "--output-dir", outputDir]),
    );

    expect(harness.calls).toEqual([
      { type: "update", outputDir, sessionId: "session-1", nextStatus: "draft" },
    ]);
    expect(logs.join("\n")).toContain(
      "Moved article for session-1 back to draft at /tmp/session-mind/drafts/opencode/session-1.md",
    );
  });
});
