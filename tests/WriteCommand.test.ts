import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Layer, Stdio } from "effect";
import * as TestConsole from "effect/testing/TestConsole";
import * as Terminal from "effect/Terminal";
import * as CliOutput from "effect/unstable/cli/CliOutput";
import * as Command from "effect/unstable/cli/Command";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { afterEach, describe, expect, it } from "vitest";
import { writeCommand } from "../src/commands/writeCommand.ts";
import { makeSessionKey } from "../src/domain/Session.ts";
import {
  SessionMindWorkflow,
  type RunWorkflowRequest,
} from "../src/services/SessionMindWorkflow.ts";
import { SessionMindOutputPaths } from "../src/domain/SubprocessProtocol.ts";
import { SessionProviderRegistry } from "../src/services/SessionProviderRegistry.ts";
import { WorkflowStateManager, type WorkflowState } from "../src/services/WorkflowStateManager.ts";
import {
  AgentResultPathPlaceholder,
  WriterPromptArgumentPlaceholder,
} from "../src/services/WriterTaskBuilder.ts";

const tempDirectories: Array<string> = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "write-command-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createHarness = ({
  recentSessionId = "session-recent",
  recentSessionTitle = "Recent session",
  workflowState,
}: {
  readonly recentSessionId?: string;
  readonly recentSessionTitle?: string;
  readonly workflowState?: WorkflowState;
} = {}) => {
  const calls: Array<RunWorkflowRequest> = [];
  const toCanonicalSessionId = (sessionId: string) =>
    sessionId.includes(":") ? sessionId : makeSessionKey("opencode", sessionId);

  const workflowLayer = Layer.succeed(
    SessionMindWorkflow,
    SessionMindWorkflow.of({
      run: (request) => {
        calls.push(request);
        return Effect.succeed({
          sessionId: request.sessionId,
          artifactPath: join(
            request.outputDir ?? request.workdir,
            SessionMindOutputPaths.draftsDirectory,
            "opencode",
            `${toCanonicalSessionId(request.sessionId).replace("opencode:", "")}.md`,
          ),
          promptBundle: {
            topicHint: request.sessionId,
            writingBrief: "Write the article.",
            sourceSessionIds: [request.sessionId],
            generatedAt: 1,
            extracted: [],
          },
          subprocess: {
            sessionId: request.sessionId,
            artifactPath: join(
              request.outputDir ?? request.workdir,
              SessionMindOutputPaths.draftsDirectory,
              "opencode",
              `${toCanonicalSessionId(request.sessionId).replace("opencode:", "")}.md`,
            ),
            promptBundlePath: join(
              request.outputDir ?? request.workdir,
              "bundles",
              "opencode",
              `${toCanonicalSessionId(request.sessionId).replace("opencode:", "")}.prompt.json`,
            ),
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        });
      },
    }),
  );
  const providerRegistryLayer = Layer.succeed(
    SessionProviderRegistry,
    SessionProviderRegistry.of({
      listRecent: () =>
        Effect.succeed([
          {
            id: makeSessionKey("opencode", recentSessionId),
            source: "opencode" as const,
            nativeId: recentSessionId,
            title: recentSessionTitle,
            directory: "/tmp/project",
            timeCreated: 1,
            timeUpdated: 2,
            projectId: "project-1",
          },
        ]),
      resolveSession: (input) =>
        Effect.succeed({
          id: toCanonicalSessionId(input),
          source: input.startsWith("claude:")
            ? ("claude" as const)
            : input.startsWith("codex:")
              ? ("codex" as const)
              : ("opencode" as const),
          nativeId: input.includes(":") ? input.slice(input.indexOf(":") + 1) : input,
          title: recentSessionTitle,
          directory: "/tmp/project",
          timeCreated: 1,
          timeUpdated: 2,
          projectId: "project-1",
        }),
      extract: () => Effect.die(new Error("Not implemented")),
    }),
  );
  const workflowStateManagerLayer = Layer.succeed(
    WorkflowStateManager,
    WorkflowStateManager.of({
      readState: () => Effect.succeed(workflowState ?? { version: 1, sessions: {} }),
      getSessionState: () => Effect.die(new Error("Not implemented")),
      initializeSession: () => Effect.die(new Error("Not implemented")),
      transition: () => Effect.die(new Error("Not implemented")),
      setArticleStatus: () => Effect.die(new Error("Not implemented")),
      markFailure: () => Effect.die(new Error("Not implemented")),
      recoverSession: () => Effect.die(new Error("Not implemented")),
    }),
  );

  const rootCommand = Command.make("session-mind").pipe(Command.withSubcommands([writeCommand]));
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
    workflowLayer,
    providerRegistryLayer,
    workflowStateManagerLayer,
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

describe("writeCommand", () => {
  it("accepts a positional session id for the main workflow entrypoint", async () => {
    const directory = await createTempDirectory();
    const outputDir = join(directory, "workflow-output");

    const harness = createHarness();
    const previousCwd = process.cwd();
    process.chdir(directory);

    try {
      const logs = await Effect.runPromise(
        harness.run(["write", "session-direct", "--output-dir", outputDir]),
      );

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toMatchObject({
        sessionId: "opencode:session-direct",
        outputDir,
        command: "codex",
        reviewCommand: "codex",
        stdioMode: "foreground",
        maxIterations: 3,
      });
      expect(harness.calls[0]?.reviewArgs).toEqual(
        expect.arrayContaining([
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "--output-last-message",
          AgentResultPathPlaceholder,
        ]),
      );
      expect(logs.join("\n")).toContain(
        `Generated draft article for opencode:session-direct at ${join(outputDir, SessionMindOutputPaths.draftsDirectory, "opencode", "session-direct.md")}`,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("resolves the session id, agent preset, and workflow output directory", async () => {
    const directory = await createTempDirectory();
    const sessionFile = join(directory, "session-1.txt");
    const outputDir = join(directory, "workflow-output");
    const presetsDir = join(directory, ".lalph", "config");

    await mkdir(presetsDir, { recursive: true });
    await writeFile(sessionFile, "session-1\n", "utf8");
    await writeFile(
      join(presetsDir, "settings.cliAgentPresets"),
      JSON.stringify([
        {
          id: "default",
          cliAgent: "codex",
          commandPrefix: [],
          extraArgs: ["--model", "gpt-5-codex"],
          sourceMetadata: {},
        },
      ]),
      "utf8",
    );

    const harness = createHarness();
    const previousCwd = process.cwd();
    process.chdir(directory);

    try {
      const logs = await Effect.runPromise(
        harness.run([
          "write",
          "--session-file",
          sessionFile,
          "--output-dir",
          outputDir,
          "--timeout",
          "45",
        ]),
      );

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toMatchObject({
        sessionId: "opencode:session-1",
        outputDir,
        timeoutMs: 45_000,
        command: "codex",
        reviewCommand: "codex",
        stdioMode: "foreground",
        maxIterations: 3,
      });
      expect(harness.calls[0]?.args).toEqual(
        expect.arrayContaining([
          "--dangerously-bypass-approvals-and-sandbox",
          "--model",
          "gpt-5-codex",
        ]),
      );
      expect(harness.calls[0]?.args).toBeDefined();
      expect(harness.calls[0]!.args?.at(-1)).toBe(WriterPromptArgumentPlaceholder);
      expect(harness.calls[0]?.reviewArgs).toEqual(
        expect.arrayContaining([
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "--output-last-message",
          AgentResultPathPlaceholder,
          "--model",
          "gpt-5-codex",
        ]),
      );
      expect(harness.calls[0]!.reviewArgs?.at(-1)).toBe(WriterPromptArgumentPlaceholder);
      expect(logs.join("\n")).toContain(
        `Generated draft article for opencode:session-1 at ${join(outputDir, SessionMindOutputPaths.draftsDirectory, "opencode", "session-1.md")}`,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("defaults to the most recently updated draft workflow session", async () => {
    const directory = await createTempDirectory();
    const outputDir = join(directory, "workflow-output");

    const harness = createHarness({
      workflowState: {
        version: 1,
        sessions: {
          "session-older": {
            sessionId: "session-older",
            stage: "complete",
            articleStatus: "draft",
            artifactPath: join(outputDir, "drafts", "session-older.md"),
            iteration: 1,
            updatedAt: 100,
            retryCount: 0,
            lastStableStage: "reviewing",
          },
          "session-latest-draft": {
            sessionId: "session-latest-draft",
            stage: "failed",
            articleStatus: "draft",
            artifactPath: join(outputDir, "drafts", "session-latest-draft.md"),
            iteration: 2,
            updatedAt: 200,
            retryCount: 1,
            lastStableStage: "executing",
            lastError: "writer failed",
          },
        },
      },
    });
    const previousCwd = process.cwd();
    process.chdir(directory);

    try {
      const logs = await Effect.runPromise(harness.run(["write", "--output-dir", outputDir]));

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toMatchObject({
        sessionId: "session-latest-draft",
        outputDir,
      });
      expect(logs.join("\n")).toContain(
        "Auto-selected draft workflow session session-latest-draft from stage failed",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("falls back to the most recent OpenCode session when no draft workflow exists", async () => {
    const directory = await createTempDirectory();
    const outputDir = join(directory, "workflow-output");

    const harness = createHarness({
      recentSessionId: "session-most-recent",
      recentSessionTitle: "Refactor CLI workflow",
      workflowState: {
        version: 1,
        sessions: {
          "session-published": {
            sessionId: "session-published",
            stage: "complete",
            articleStatus: "published",
            artifactPath: join(outputDir, "published", "session-published.md"),
            iteration: 1,
            updatedAt: 300,
            retryCount: 0,
            lastStableStage: "reviewing",
          },
        },
      },
    });
    const previousCwd = process.cwd();
    process.chdir(directory);

    try {
      const logs = await Effect.runPromise(
        harness.run(["write", "--latest", "--output-dir", outputDir]),
      );

      expect(harness.calls).toHaveLength(1);
      expect(harness.calls[0]).toMatchObject({
        sessionId: "opencode:session-most-recent",
        outputDir,
      });
      expect(logs.join("\n")).toContain(
        "Auto-selected most recent opencode session opencode:session-most-recent (Refactor CLI workflow)",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("renders help with the write-specific flags and examples", async () => {
    const harness = createHarness();

    const logs = await Effect.runPromise(harness.run(["write", "--help"]));
    const output = logs.join("\n");

    expect(output).toContain("Run the full article-writing workflow for one session");
    expect(output).toContain("session-id");
    expect(output).toContain("--session-file");
    expect(output).toContain("--latest");
    expect(output).toContain("--resume-latest");
    expect(output).toContain("--output-dir");
    expect(output).toContain("--timeout");
    expect(output).toContain("--max-iterations");
    expect(output).toContain("--agent-preset");
    expect(output).toContain("session-mind write session-123");
    expect(output).toContain("session-mind write --latest");
    expect(output).toContain("session-mind write --session-file ./session-123.json");
  });
});
