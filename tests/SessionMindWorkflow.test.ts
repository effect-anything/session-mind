import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtractedConversation, PromptBundle } from "../src/domain/Session";
import { PromptComposer } from "../src/services/PromptComposer";
import { ArtifactValidator } from "../src/services/ArtifactValidator";
import { SessionMindWorkflow } from "../src/services/SessionMindWorkflow";
import { SubprocessSpawner } from "../src/services/SubprocessSpawner";
import {
  WorkflowStateManager,
  type ActiveWorkflowStage,
  type SessionWorkflowState,
  type WorkflowRecovery,
} from "../src/services/WorkflowStateManager";
import { WorkflowSessionExtractor } from "../src/services/WorkflowSessionExtractor";
import { SubprocessError } from "../src/domain/SessionMindErrors";

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

type WorkflowHarness = {
  readonly calls: {
    readonly initialize: Array<string>;
    readonly transitions: Array<string>;
    readonly failures: Array<string>;
    readonly extracts: Array<string>;
    readonly compositions: Array<ReadonlyArray<string>>;
    readonly spawns: Array<string>;
    readonly validations: Array<string>;
  };
  readonly layer: Layer.Layer<SessionMindWorkflow>;
};

const createState = (
  stage: SessionWorkflowState["stage"],
  lastStableStage: ActiveWorkflowStage | undefined = "extracting",
): SessionWorkflowState => ({
  sessionId: "session-1",
  stage,
  artifactPath: "/tmp/.output/session-mind/articles/session-1.md",
  updatedAt: 10,
  retryCount: stage === "failed" ? 1 : 0,
  ...(lastStableStage !== undefined ? { lastStableStage } : {}),
  ...(stage === "failed" ? { lastError: "broken" } : {}),
  promptBundlePath: "/tmp/.output/session-mind/bundles/session-1.prompt.json",
});

const createHarness = (options?: {
  readonly recovery?: WorkflowRecovery;
  readonly spawnError?: SubprocessError;
}): WorkflowHarness => {
  const calls = {
    initialize: [] as Array<string>,
    transitions: [] as Array<string>,
    failures: [] as Array<string>,
    extracts: [] as Array<string>,
    compositions: [] as Array<ReadonlyArray<string>>,
    spawns: [] as Array<string>,
    validations: [] as Array<string>,
  };

  const extractorLayer = Layer.succeed(
    WorkflowSessionExtractor,
    WorkflowSessionExtractor.of({
      extract: (sessionId) => {
        calls.extracts.push(sessionId);
        return Effect.succeed(extractedConversation);
      },
    }),
  );

  const composerLayer = Layer.succeed(
    PromptComposer,
    PromptComposer.of({
      compose: (extracted) => {
        calls.compositions.push(extracted.map((item) => item.session.id));
        return Effect.succeed(promptBundle);
      },
    }),
  );

  const spawnerLayer = Layer.succeed(
    SubprocessSpawner,
    SubprocessSpawner.of({
      spawn: ({ sessionId }) => {
        calls.spawns.push(sessionId);
        if (options?.spawnError) {
          return Effect.fail(options.spawnError);
        }

        return Effect.succeed({
          sessionId,
          artifactPath: "/tmp/.output/session-mind/articles/session-1.md",
          promptBundlePath: "/tmp/.output/session-mind/bundles/session-1.prompt.json",
          exitCode: 0,
          stdout: "ok",
          stderr: "",
        });
      },
    }),
  );

  const validatorLayer = Layer.succeed(
    ArtifactValidator,
    ArtifactValidator.of({
      validate: (artifactPath) => {
        calls.validations.push(artifactPath);
        return Effect.succeed({
          artifactPath,
          isValid: true,
          contentLength: 48,
          issues: [],
        });
      },
    }),
  );

  const recovery = options?.recovery ?? { action: "start" } satisfies WorkflowRecovery;

  const stateLayer = Layer.succeed(
    WorkflowStateManager,
    WorkflowStateManager.of({
      readState: () => Effect.succeed({ version: 1, sessions: {} }),
      getSessionState: () => Effect.succeed(Option.none()),
      initializeSession: ({ sessionId, artifactPath }) => {
        calls.initialize.push(sessionId);
        return Effect.succeed({
          sessionId,
          stage: "extracting",
          artifactPath,
          updatedAt: 1,
          retryCount: 0,
          lastStableStage: "extracting",
        });
      },
      transition: ({ nextStage, artifactPath, promptBundlePath }) => {
        calls.transitions.push(nextStage);
        return Effect.succeed({
          sessionId: "session-1",
          stage: nextStage,
          artifactPath: artifactPath ?? "/tmp/.output/session-mind/articles/session-1.md",
          updatedAt: 2,
          retryCount: 0,
          ...(nextStage !== "complete" && nextStage !== "failed"
            ? { lastStableStage: nextStage }
            : { lastStableStage: "validating" as const }),
          ...(promptBundlePath !== undefined ? { promptBundlePath } : {}),
        });
      },
      markFailure: ({ message }) => {
        calls.failures.push(message);
        return Effect.succeed(createState("failed", "executing"));
      },
      recoverSession: () => Effect.succeed(recovery),
    }),
  );

  return {
    calls,
    layer: SessionMindWorkflow.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          extractorLayer,
          composerLayer,
          spawnerLayer,
          validatorLayer,
          stateLayer,
        ),
      ),
    ),
  };
};

const runWorkflow = (harness: WorkflowHarness) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const workflow = yield* SessionMindWorkflow;
      return yield* workflow.run({
        sessionId: "session-1",
        command: "node",
        workdir: "/tmp",
      });
    }).pipe(Effect.provide(harness.layer)),
  );

describe("SessionMindWorkflow", () => {
  it("orchestrates extract -> generate -> spawn -> validate and completes state transitions", async () => {
    const harness = createHarness();

    const result = await runWorkflow(harness);

    expect(result.artifactPath).toContain("session-1.md");
    expect(harness.calls.initialize).toEqual(["session-1"]);
    expect(harness.calls.extracts).toEqual(["session-1"]);
    expect(harness.calls.compositions).toEqual([["session-1"]]);
    expect(harness.calls.spawns).toEqual(["session-1"]);
    expect(harness.calls.validations).toEqual([
      "/tmp/.output/session-mind/articles/session-1.md",
    ]);
    expect(harness.calls.transitions).toEqual([
      "generating",
      "executing",
      "validating",
      "complete",
    ]);
  });

  it("short-circuits when the session is already complete", async () => {
    const harness = createHarness({
      recovery: {
        action: "complete",
        state: createState("complete", "validating"),
      },
    });

    const result = await runWorkflow(harness);

    expect(result.artifactPath).toContain("session-1.md");
    expect(harness.calls.initialize).toEqual([]);
    expect(harness.calls.extracts).toEqual([]);
    expect(harness.calls.spawns).toEqual([]);
    expect(harness.calls.validations).toEqual([]);
  });

  it("marks the workflow failed when subprocess execution errors", async () => {
    const harness = createHarness({
      spawnError: new SubprocessError({
        code: "SUBPROCESS_EXITED_NON_ZERO",
        message: "child failed",
        context: {
          command: "node",
          args: [],
          outputDir: "/tmp/.output/session-mind",
          sessionId: "session-1",
        },
      }),
    });

    await expect(runWorkflow(harness)).rejects.toMatchObject({
      _tag: "SubprocessError",
      code: "SUBPROCESS_EXITED_NON_ZERO",
    });

    expect(harness.calls.failures).toEqual(["child failed"]);
    expect(harness.calls.transitions).toEqual(["generating", "executing"]);
  });

  it("resumes from a failed validating state without re-spawning the subprocess", async () => {
    const harness = createHarness({
      recovery: {
        action: "resume",
        nextStage: "validating",
        state: createState("failed", "validating"),
      },
    });

    const result = await runWorkflow(harness);

    expect(result.subprocess.exitCode).toBe(0);
    expect(harness.calls.transitions).toEqual(["validating", "complete"]);
    expect(harness.calls.spawns).toEqual([]);
    expect(harness.calls.validations).toEqual([
      "/tmp/.output/session-mind/articles/session-1.md",
    ]);
  });
});
