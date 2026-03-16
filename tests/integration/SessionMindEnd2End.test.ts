import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { ExtractedConversationSchema, type ExtractedConversation } from "../../src/domain/Session";
import { ExtractionError, type SessionMindError } from "../../src/domain/SessionMindErrors";
import {
  SessionMindEnvironmentVariables,
  SessionMindOutputPaths,
} from "../../src/domain/SubprocessProtocol";
import {
  SessionMindWorkflow,
  type RunWorkflowRequest,
} from "../../src/services/SessionMindWorkflow";
import { ArtifactValidator } from "../../src/services/ArtifactValidator";
import { PromptComposer } from "../../src/services/PromptComposer";
import { SubprocessSpawner } from "../../src/services/SubprocessSpawner";
import { WorkflowStateManager } from "../../src/services/WorkflowStateManager";
import { WorkflowSessionExtractor } from "../../src/services/WorkflowSessionExtractor";

const tempDirectories: Array<string> = [];
const decodeExtractedConversation = Schema.decodeUnknownEffect(ExtractedConversationSchema);

const createTempDirectory = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "session-mind-e2e-"));
  tempDirectories.push(directory);
  return directory;
};

const createMockConversation = (
  sessionId: string,
  title: string,
  turns: ReadonlyArray<{
    readonly role: "user" | "assistant";
    readonly content: string;
  }>,
): ExtractedConversation => ({
  session: {
    id: sessionId,
    title,
    directory: `/workspace/${sessionId}`,
    timeCreated: 1,
    timeUpdated: 2,
    projectId: "project-1",
  },
  turns: turns.map((turn, index) => ({
    ...turn,
    timestamp: index + 1,
    sessionId,
    messageId: `${sessionId}-message-${index + 1}`,
  })),
  extractedAt: 3,
  stats: {
    totalMessages: turns.length,
    totalParts: turns.length,
    keptTurns: turns.length,
    droppedToolParts: 0,
    droppedReasoningParts: 0,
    droppedStepParts: 0,
    droppedEmptyTextParts: 0,
  },
});

const createMockSessionFile = async (
  sessionsDirectory: string,
  conversation: ExtractedConversation,
): Promise<void> => {
  await mkdir(sessionsDirectory, { recursive: true });
  await writeFile(
    join(sessionsDirectory, `${conversation.session.id}.json`),
    JSON.stringify(conversation, null, 2),
    "utf8",
  );
};

const createSubprocessScript = async (
  directory: string,
  name: string,
  source: string,
): Promise<string> => {
  const scriptPath = join(directory, `${name}.cjs`);
  await writeFile(scriptPath, source, "utf8");
  return scriptPath;
};

const buildSuccessfulWriterScript = (delayMs = 0): string =>
  [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const bundle = JSON.parse(process.env.${SessionMindEnvironmentVariables.promptBundle});`,
    `const outputDir = process.env.${SessionMindEnvironmentVariables.outputDir};`,
    `const sessionId = process.env.${SessionMindEnvironmentVariables.sessionId};`,
    "const artifactPath = path.join(outputDir, 'articles', `${sessionId}.md`);",
    "const article = [",
    "  `# ${bundle.topicHint}`,",
    "  '',",
    "  `Sources: ${bundle.sourceSessionIds.join(', ')}`,",
    "  '',",
    "  ...bundle.extracted.flatMap((conversation) =>",
    "    conversation.turns.map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`),",
    "  ),",
    "  '',",
    "  'This generated article body is intentionally long enough to satisfy artifact validation. '.repeat(5),",
    "].join('\\n');",
    `setTimeout(() => {`,
    "  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });",
    "  fs.writeFileSync(artifactPath, article, 'utf8');",
    "  process.stdout.write(`artifact-written:${sessionId}`);",
    `}, ${delayMs});`,
  ].join("\n");

const buildTooShortWriterScript = (): string =>
  [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const outputDir = process.env.${SessionMindEnvironmentVariables.outputDir};`,
    `const sessionId = process.env.${SessionMindEnvironmentVariables.sessionId};`,
    "const artifactPath = path.join(outputDir, 'articles', `${sessionId}.md`);",
    "fs.mkdirSync(path.dirname(artifactPath), { recursive: true });",
    "fs.writeFileSync(artifactPath, '# short\\n\\nToo short.', 'utf8');",
    "process.stdout.write(`short-artifact:${sessionId}`);",
  ].join("\n");

const buildFailureScript = (message: string): string =>
  [`process.stderr.write(${JSON.stringify(message)});`, "process.exit(3);"].join("\n");

const createWorkflowLayer = (sessionsDirectory: string): Layer.Layer<SessionMindWorkflow> => {
  const extractorLayer = Layer.succeed(
    WorkflowSessionExtractor,
    WorkflowSessionExtractor.of({
      extract: (sessionId) =>
        Effect.tryPromise({
          try: async () =>
            JSON.parse(
              await readFile(join(sessionsDirectory, `${sessionId}.json`), "utf8"),
            ) as unknown,
          catch: (cause) =>
            new ExtractionError({
              code: "SESSION_READ_FAILED",
              message: "Failed to load mock integration session",
              context: {
                sessionId,
                sessionPath: join(sessionsDirectory, `${sessionId}.json`),
                details: { cause: String(cause) },
              },
            }),
        }).pipe(
          Effect.flatMap((raw) =>
            decodeExtractedConversation(raw).pipe(
              Effect.mapError(
                (cause) =>
                  new ExtractionError({
                    code: "UNSUPPORTED_SESSION_FORMAT",
                    message: "Mock integration session file is invalid",
                    context: {
                      sessionId,
                      sessionPath: join(sessionsDirectory, `${sessionId}.json`),
                      details: { cause: String(cause) },
                    },
                  }),
              ),
            ),
          ),
        ),
    }),
  );

  return SessionMindWorkflow.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        extractorLayer,
        PromptComposer.layer,
        SubprocessSpawner.layer,
        ArtifactValidator.layer,
        WorkflowStateManager.layer,
      ),
    ),
  );
};

const runWorkflow = (
  layer: Layer.Layer<SessionMindWorkflow>,
  request: RunWorkflowRequest,
): Promise<Awaited<ReturnType<InstanceType<typeof SessionMindWorkflow>["run"]>>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* SessionMindWorkflow;
      return yield* workflow.run(request);
    }).pipe(Effect.provide(layer)),
  );

const readWorkflowState = async (workdir: string) =>
  JSON.parse(
    await readFile(
      join(workdir, SessionMindOutputPaths.workflowRoot, SessionMindOutputPaths.stateFile),
      "utf8",
    ),
  ) as {
    readonly sessions: Record<
      string,
      {
        readonly stage: string;
        readonly retryCount: number;
        readonly lastError?: string;
        readonly promptBundlePath?: string;
      }
    >;
  };

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SessionMind end-to-end integration", () => {
  it("runs the full workflow with mock session files, real subprocess execution, and artifact validation", async () => {
    const workdir = await createTempDirectory();
    const sessionsDirectory = join(workdir, "mock-sessions");
    const sessionId = "session-success";

    await createMockSessionFile(
      sessionsDirectory,
      createMockConversation(sessionId, "Integration workflow", [
        {
          role: "user",
          content: "Turn this debugging session into an article.",
        },
        {
          role: "assistant",
          content: "Focus on the real failure, the fix, and the recovery path.",
        },
      ]),
    );

    const scriptPath = await createSubprocessScript(
      workdir,
      "write-success",
      buildSuccessfulWriterScript(),
    );

    const result = await runWorkflow(createWorkflowLayer(sessionsDirectory), {
      sessionId,
      command: process.execPath,
      args: [scriptPath],
      cwd: workdir,
      workdir,
    });

    const artifactContent = await readFile(result.artifactPath, "utf8");
    const promptBundle = JSON.parse(await readFile(result.subprocess.promptBundlePath, "utf8")) as {
      readonly sourceSessionIds: ReadonlyArray<string>;
      readonly extracted: ReadonlyArray<{ readonly session: { readonly id: string } }>;
    };
    const state = await readWorkflowState(workdir);

    expect(result.subprocess.stdout).toContain(`artifact-written:${sessionId}`);
    expect(artifactContent).toContain("# Integration workflow");
    expect(artifactContent.length).toBeGreaterThan(200);
    expect(promptBundle.sourceSessionIds).toEqual([sessionId]);
    expect(promptBundle.extracted[0]?.session.id).toBe(sessionId);
    expect(state.sessions[sessionId]).toMatchObject({
      stage: "complete",
      promptBundlePath: result.subprocess.promptBundlePath,
    });
  });

  it("fails the workflow when the generated artifact does not pass validation", async () => {
    const workdir = await createTempDirectory();
    const sessionsDirectory = join(workdir, "mock-sessions");
    const sessionId = "session-invalid-artifact";

    await createMockSessionFile(
      sessionsDirectory,
      createMockConversation(sessionId, "Validation workflow", [
        {
          role: "user",
          content: "Generate the article draft.",
        },
      ]),
    );

    const scriptPath = await createSubprocessScript(
      workdir,
      "write-too-short",
      buildTooShortWriterScript(),
    );

    await expect(
      runWorkflow(createWorkflowLayer(sessionsDirectory), {
        sessionId,
        command: process.execPath,
        args: [scriptPath],
        cwd: workdir,
        workdir,
      }),
    ).rejects.toMatchObject({
      _tag: "ValidationError",
      code: "ARTIFACT_TOO_SHORT",
    } satisfies Partial<SessionMindError>);

    const state = await readWorkflowState(workdir);

    expect(state.sessions[sessionId]).toMatchObject({
      stage: "failed",
      retryCount: 1,
    });
    expect(state.sessions[sessionId]?.lastError).toContain("at least");
  });

  it("re-runs generation after a validation failure so a fresh artifact can complete", async () => {
    const workdir = await createTempDirectory();
    const sessionsDirectory = join(workdir, "mock-sessions");
    const sessionId = "session-validation-retry";
    const layer = createWorkflowLayer(sessionsDirectory);

    await createMockSessionFile(
      sessionsDirectory,
      createMockConversation(sessionId, "Validation retry workflow", [
        {
          role: "user",
          content: "Retry article generation if the first draft is invalid.",
        },
        {
          role: "assistant",
          content: "Run the writer again instead of validating the same broken file.",
        },
      ]),
    );

    const shortScriptPath = await createSubprocessScript(
      workdir,
      "write-short-retry",
      buildTooShortWriterScript(),
    );

    await expect(
      runWorkflow(layer, {
        sessionId,
        command: process.execPath,
        args: [shortScriptPath],
        cwd: workdir,
        workdir,
      }),
    ).rejects.toMatchObject({
      _tag: "ValidationError",
      code: "ARTIFACT_TOO_SHORT",
    } satisfies Partial<SessionMindError>);

    const failedState = await readWorkflowState(workdir);
    expect(failedState.sessions[sessionId]).toMatchObject({
      stage: "failed",
      retryCount: 1,
    });

    const successfulScriptPath = await createSubprocessScript(
      workdir,
      "write-valid-retry",
      buildSuccessfulWriterScript(),
    );

    const recovered = await runWorkflow(layer, {
      sessionId,
      command: process.execPath,
      args: [successfulScriptPath],
      cwd: workdir,
      workdir,
    });

    const recoveredArtifact = await readFile(recovered.artifactPath, "utf8");
    const finalState = await readWorkflowState(workdir);

    expect(recovered.subprocess.stdout).toContain(`artifact-written:${sessionId}`);
    expect(recoveredArtifact).toContain("# Validation retry workflow");
    expect(recoveredArtifact.length).toBeGreaterThan(200);
    expect(finalState.sessions[sessionId]).toMatchObject({
      stage: "complete",
      retryCount: 1,
    });
  });

  it("recovers from a failed subprocess run on the next execution", async () => {
    const workdir = await createTempDirectory();
    const sessionsDirectory = join(workdir, "mock-sessions");
    const sessionId = "session-retry";
    const layer = createWorkflowLayer(sessionsDirectory);

    await createMockSessionFile(
      sessionsDirectory,
      createMockConversation(sessionId, "Recovery workflow", [
        {
          role: "user",
          content: "Retry the article generation if the worker fails.",
        },
        {
          role: "assistant",
          content: "Resume from the executing stage and keep the same state file.",
        },
      ]),
    );

    const failingScriptPath = await createSubprocessScript(
      workdir,
      "write-fail",
      buildFailureScript("worker crashed"),
    );

    await expect(
      runWorkflow(layer, {
        sessionId,
        command: process.execPath,
        args: [failingScriptPath],
        cwd: workdir,
        workdir,
      }),
    ).rejects.toMatchObject({
      _tag: "SubprocessError",
      code: "SUBPROCESS_EXITED_NON_ZERO",
    } satisfies Partial<SessionMindError>);

    const failedState = await readWorkflowState(workdir);
    expect(failedState.sessions[sessionId]).toMatchObject({
      stage: "failed",
      retryCount: 1,
    });

    const successfulScriptPath = await createSubprocessScript(
      workdir,
      "write-recovered",
      buildSuccessfulWriterScript(),
    );

    const recovered = await runWorkflow(layer, {
      sessionId,
      command: process.execPath,
      args: [successfulScriptPath],
      cwd: workdir,
      workdir,
    });

    const finalState = await readWorkflowState(workdir);
    const recoveredArtifact = await readFile(recovered.artifactPath, "utf8");

    expect(recovered.subprocess.stdout).toContain(`artifact-written:${sessionId}`);
    expect(recoveredArtifact).toContain("# Recovery workflow");
    expect(finalState.sessions[sessionId]).toMatchObject({
      stage: "complete",
      retryCount: 1,
    });
  });

  it("supports concurrent workflow execution without losing shared state updates", async () => {
    const workdir = await createTempDirectory();
    const sessionsDirectory = join(workdir, "mock-sessions");
    const sessionIds = ["session-a", "session-b", "session-c"];
    const layer = createWorkflowLayer(sessionsDirectory);

    await Promise.all(
      sessionIds.map((sessionId, index) =>
        createMockSessionFile(
          sessionsDirectory,
          createMockConversation(sessionId, `Concurrent workflow ${index + 1}`, [
            {
              role: "user",
              content: `Write article ${index + 1}.`,
            },
            {
              role: "assistant",
              content: `Keep the session ${sessionId} output separate.`,
            },
          ]),
        ),
      ),
    );

    const scriptPath = await createSubprocessScript(
      workdir,
      "write-concurrent",
      buildSuccessfulWriterScript(25),
    );

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const workflow = yield* SessionMindWorkflow;
        return yield* Effect.all(
          sessionIds.map((sessionId) =>
            workflow.run({
              sessionId,
              command: process.execPath,
              args: [scriptPath],
              cwd: workdir,
              workdir,
            }),
          ),
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(layer)),
    );

    const state = await readWorkflowState(workdir);
    const persistedSessionIds = Object.keys(state.sessions).sort();

    expect(results.map((result) => result.sessionId).sort()).toEqual([...sessionIds].sort());
    expect(persistedSessionIds).toEqual([...sessionIds].sort());

    await Promise.all(
      results.map(async (result) => {
        const artifactContent = await readFile(result.artifactPath, "utf8");
        expect(artifactContent).toContain(`# ${result.promptBundle.topicHint}`);
        expect(state.sessions[result.sessionId]?.stage).toBe("complete");
      }),
    );
  });
});
