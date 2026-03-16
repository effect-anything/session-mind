import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtractedConversation, PromptBundle } from "../src/domain/Session";
import {
  SessionMindOutputPaths,
  SubprocessEnvironmentVariable,
} from "../src/domain/SubprocessProtocol";
import { SubprocessSpawner } from "../src/services/SubprocessSpawner";

const tempDirectories: Array<string> = [];

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "subprocess-spawner-"));
  tempDirectories.push(directory);
  return directory;
};

const extractedConversation: ExtractedConversation = {
  session: {
    id: "session-1",
    title: "Workflow session",
    directory: "/workspace",
    timeCreated: 1,
    timeUpdated: 2,
    projectId: "project-1",
  },
  turns: [
    {
      role: "user",
      content: "Turn this session into an article.",
      timestamp: 1,
      sessionId: "session-1",
      messageId: "message-1",
    },
  ],
  extractedAt: 3,
  stats: {
    totalMessages: 1,
    totalParts: 1,
    keptTurns: 1,
    droppedToolParts: 0,
    droppedReasoningParts: 0,
    droppedStepParts: 0,
    droppedEmptyTextParts: 0,
  },
};

const promptBundle: PromptBundle = {
  topicHint: "Workflow session",
  prompt: "Write the article.",
  sourceSessionIds: ["session-1"],
  generatedAt: 4,
  extracted: [extractedConversation],
};

const spawnSubprocess = (directory: string, args: ReadonlyArray<string>, timeoutMs?: number) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const spawner = yield* SubprocessSpawner;
      return yield* spawner.spawn({
        command: process.execPath,
        args,
        cwd: directory,
        sessionId: "session-1",
        promptBundle,
        outputDir: join(directory, SessionMindOutputPaths.workflowRoot),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
    }).pipe(Effect.provide(SubprocessSpawner.layer)),
  );

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SubprocessSpawner", () => {
  it("spawns a subprocess, passes protocol environment variables, and captures success output", async () => {
    const directory = await createTempDirectory();
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const compactBundleText = process.env.${SubprocessEnvironmentVariable.promptBundle};`,
      "const bundle = JSON.parse(compactBundleText);",
      `const outputDir = process.env.${SubprocessEnvironmentVariable.outputDir};`,
      `const sessionId = process.env.${SubprocessEnvironmentVariable.sessionId};`,
      "const bundlePath = path.join(outputDir, 'bundles', `${sessionId}.prompt.json`);",
      "const persistedBundleRaw = fs.readFileSync(bundlePath, 'utf8');",
      "const persistedBundleText = persistedBundleRaw;",
      `const envBundleRaw = process.env.${SubprocessEnvironmentVariable.promptBundle};`,
      "const persistedBundle = JSON.parse(persistedBundleRaw);",
      "const artifactPath = path.join(outputDir, 'articles', `${sessionId}.md`);",
      "fs.mkdirSync(path.dirname(artifactPath), { recursive: true });",
      "if (compactBundleText !== JSON.stringify(bundle)) { process.exit(6); }",
      "if (persistedBundleText !== JSON.stringify(bundle, null, 2)) { process.exit(7); }",
      "if (persistedBundle.topicHint !== bundle.topicHint) { process.exit(5); }",
      "fs.writeFileSync(artifactPath, `# ${bundle.topicHint}\\n\\nThis generated article content is intentionally long enough to pass validation.`);",
      "process.stdout.write(JSON.stringify({ sessionId, envBundleRaw, persistedBundleRaw, sourceSessionIds: persistedBundle.sourceSessionIds }));",
    ].join("");

    const result = await spawnSubprocess(directory, ["-e", script], 1_000);
    const stdoutPayload = JSON.parse(result.stdout) as {
      sessionId: string;
      envBundleRaw: string;
      persistedBundleRaw: string;
      sourceSessionIds: ReadonlyArray<string>;
    };

    expect(result.exitCode).toBe(0);
    expect(stdoutPayload).toEqual({
      sessionId: "session-1",
      envBundleRaw: JSON.stringify(promptBundle),
      persistedBundleRaw: JSON.stringify(promptBundle, null, 2),
      sourceSessionIds: ["session-1"],
    });
    expect(result.artifactPath).toBe(
      join(directory, SessionMindOutputPaths.workflowRoot, "articles", "session-1.md"),
    );

    const persistedBundle = JSON.parse(
      await readFile(result.promptBundlePath, "utf8"),
    ) as PromptBundle;
    expect(persistedBundle.topicHint).toBe("Workflow session");
    expect(result.promptBundlePath).toContain("session-1.prompt.json");
  });

  it("returns a protocol violation when the subprocess exits successfully without writing the artifact", async () => {
    const directory = await createTempDirectory();
    const script = "process.stdout.write('no artifact');";

    await expect(spawnSubprocess(directory, ["-e", script], 1_000)).rejects.toMatchObject({
      _tag: "SubprocessError",
      code: "SUBPROCESS_PROTOCOL_VIOLATION",
      context: expect.objectContaining({
        details: expect.objectContaining({
          stdout: "no artifact",
        }),
      }),
    });
  });

  it("returns a typed error when the subprocess exits non-zero", async () => {
    const directory = await createTempDirectory();
    const script = "process.stderr.write('boom'); process.exit(3);";

    await expect(spawnSubprocess(directory, ["-e", script], 1_000)).rejects.toMatchObject({
      _tag: "SubprocessError",
      code: "SUBPROCESS_EXITED_NON_ZERO",
      context: expect.objectContaining({
        exitCode: 3,
      }),
    });
  });

  it("terminates the subprocess when it exceeds the timeout", async () => {
    const directory = await createTempDirectory();
    const script = "setTimeout(() => process.exit(0), 5_000);";

    await expect(spawnSubprocess(directory, ["-e", script], 50)).rejects.toMatchObject({
      _tag: "SubprocessError",
      code: "SUBPROCESS_TIMED_OUT",
    });
  });
});
