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
import { writeCommand } from "../src/commands/writeCommand";
import {
  SessionMindWorkflow,
  type RunWorkflowRequest,
} from "../src/services/SessionMindWorkflow";

const tempDirectories: Array<string> = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "write-command-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

const createHarness = () => {
  const calls: Array<RunWorkflowRequest> = [];

  const workflowLayer = Layer.succeed(
    SessionMindWorkflow,
    SessionMindWorkflow.of({
      run: (request) => {
        calls.push(request);
        return Effect.succeed({
          sessionId: request.sessionId,
          artifactPath: join(request.outputDir ?? request.workdir, "articles", `${request.sessionId}.md`),
          promptBundle: {
            topicHint: request.sessionId,
            prompt: "Write the article.",
            sourceSessionIds: [request.sessionId],
            generatedAt: 1,
            extracted: [],
          },
          subprocess: {
            sessionId: request.sessionId,
            artifactPath: join(
              request.outputDir ?? request.workdir,
              "articles",
              `${request.sessionId}.md`,
            ),
            promptBundlePath: join(
              request.outputDir ?? request.workdir,
              "bundles",
              `${request.sessionId}.prompt.json`,
            ),
            exitCode: 0,
            stdout: "",
            stderr: "",
          },
        });
      },
    }),
  );

  const rootCommand = Command.make("session-article").pipe(
    Command.withSubcommands([writeCommand]),
  );
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
        sessionId: "session-1",
        outputDir,
        timeoutMs: 45_000,
        command: "codex",
      });
      expect(harness.calls[0]?.args).toEqual(
        expect.arrayContaining([
          "exec",
          "--dangerously-bypass-approvals-and-sandbox",
          "--model",
          "gpt-5-codex",
        ]),
      );
      expect(harness.calls[0]?.args).toBeDefined();
      expect(harness.calls[0]!.args?.at(-1)).toContain("SESSION_MIND_PROMPT_BUNDLE");
      expect(logs.join("\n")).toContain(
        `Generated article for session-1 at ${join(outputDir, "articles", "session-1.md")}`,
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("renders help with the write-specific flags and examples", async () => {
    const harness = createHarness();

    const logs = await Effect.runPromise(harness.run(["write", "--help"]));
    const output = logs.join("\n");

    expect(output).toContain("Run the session-mind workflow for one session file");
    expect(output).toContain("--session-file");
    expect(output).toContain("--output-dir");
    expect(output).toContain("--timeout");
    expect(output).toContain("--agent-preset");
    expect(output).toContain(
      "session-article write --session-file ./session-123.json",
    );
  });
});
