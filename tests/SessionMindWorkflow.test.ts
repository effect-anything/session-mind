import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { ArticleStatus } from "../src/domain/Article.ts";
import type { ExtractedConversation, PromptBundle } from "../src/domain/Session.ts";
import { SessionMindOutputPaths } from "../src/domain/SubprocessProtocol.ts";
import { ArtifactValidator } from "../src/services/ArtifactValidator.ts";
import { SessionMindWorkflow } from "../src/services/SessionMindWorkflow.ts";
import { SubprocessSpawner } from "../src/services/SubprocessSpawner.ts";
import {
  WorkflowStateManager,
  type ActiveWorkflowStage,
  type SessionWorkflowState,
  type WorkflowRecovery,
} from "../src/services/WorkflowStateManager.ts";
import { WorkflowSessionExtractor } from "../src/services/WorkflowSessionExtractor.ts";
import { SubprocessError } from "../src/domain/SessionMindErrors.ts";
import { WritingBriefComposer } from "../src/services/WritingBriefComposer.ts";
import { WorkflowReviewer } from "../src/services/WorkflowReviewer.ts";

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
  writingBrief: "Write the article.",
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
    readonly reviews: Array<string>;
  };
  readonly layer: Layer.Layer<SessionMindWorkflow>;
};

const createState = (
  stage: SessionWorkflowState["stage"],
  lastStableStage: ActiveWorkflowStage | undefined = "extracting",
  articleStatus: ArticleStatus = "draft",
): SessionWorkflowState => ({
  sessionId: "session-1",
  stage,
  articleStatus,
  artifactPath: `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
  iteration: 1,
  updatedAt: 10,
  retryCount: stage === "failed" ? 1 : 0,
  ...(lastStableStage !== undefined ? { lastStableStage } : {}),
  ...(stage === "failed" ? { lastError: "broken" } : {}),
  promptBundlePath: "/tmp/.output/session-mind/bundles/session-1.prompt.json",
});

const createHarness = (options?: {
  readonly recovery?: WorkflowRecovery;
  readonly spawnError?: SubprocessError;
  readonly reviewOutcomes?: ReadonlyArray<
    { readonly status: "completed" } | { readonly status: "revise"; readonly revisionBrief: string }
  >;
}): WorkflowHarness => {
  const calls = {
    initialize: [] as Array<string>,
    transitions: [] as Array<string>,
    failures: [] as Array<string>,
    extracts: [] as Array<string>,
    compositions: [] as Array<ReadonlyArray<string>>,
    spawns: [] as Array<string>,
    validations: [] as Array<string>,
    reviews: [] as Array<string>,
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
    WritingBriefComposer,
    WritingBriefComposer.of({
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
          artifactPath: `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
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

  const recovery = options?.recovery ?? ({ action: "start" } satisfies WorkflowRecovery);

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
          articleStatus: "draft" as const,
          iteration: 1,
          updatedAt: 1,
          retryCount: 0,
          lastStableStage: "extracting",
        });
      },
      transition: ({
        nextStage,
        artifactPath,
        promptBundlePath,
        iteration,
        lastValidationIssues,
      }) => {
        calls.transitions.push(nextStage);
        return Effect.succeed({
          sessionId: "session-1",
          stage: nextStage,
          articleStatus: "draft" as const,
          artifactPath:
            artifactPath ??
            `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
          iteration: iteration ?? 1,
          updatedAt: 2,
          retryCount: 0,
          ...(nextStage !== "complete" && nextStage !== "failed"
            ? { lastStableStage: nextStage }
            : { lastStableStage: "validating" as const }),
          ...(promptBundlePath !== undefined ? { promptBundlePath } : {}),
          ...(lastValidationIssues !== undefined ? { lastValidationIssues } : {}),
        });
      },
      markFailure: ({ message }) => {
        calls.failures.push(message);
        return Effect.succeed(createState("failed", "executing"));
      },
      setArticleStatus: ({ articleStatus, artifactPath }) =>
        Effect.succeed({
          ...createState("complete", "validating", articleStatus),
          artifactPath,
        }),
      recoverSession: () => Effect.succeed(recovery),
    }),
  );

  const reviewerLayer = Layer.succeed(
    WorkflowReviewer,
    WorkflowReviewer.of({
      review: ({ artifactPath }) => {
        calls.reviews.push(artifactPath);
        const nextOutcome = options?.reviewOutcomes?.at(calls.reviews.length - 1);
        return Effect.succeed(nextOutcome ?? { status: "completed" as const });
      },
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
          reviewerLayer,
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
      `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
    ]);
    expect(harness.calls.transitions).toEqual([
      "generating",
      "executing",
      "validating",
      "reviewing",
      "complete",
    ]);
  });

  it("rejects rerunning write against a published article", async () => {
    const harness = createHarness({
      recovery: {
        action: "complete",
        state: createState("complete", "validating", "published"),
      },
    });

    await expect(runWorkflow(harness)).rejects.toMatchObject({
      _tag: "ValidationError",
      code: "ARTIFACT_CHECK_FAILED",
    });
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

  it("resumes from a failed validating state by re-spawning the subprocess", async () => {
    const harness = createHarness({
      recovery: {
        action: "resume",
        nextStage: "executing",
        state: createState("failed", "validating"),
      },
    });

    const result = await runWorkflow(harness);

    expect(result.subprocess.exitCode).toBe(0);
    expect(harness.calls.transitions).toEqual(["executing", "validating", "reviewing", "complete"]);
    expect(harness.calls.spawns).toEqual(["session-1"]);
    expect(harness.calls.validations).toEqual([
      `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
    ]);
  });

  it("reopens a completed draft when write runs again", async () => {
    const harness = createHarness({
      recovery: {
        action: "resume",
        nextStage: "generating",
        state: createState("complete", "validating", "draft"),
      },
    });

    const result = await runWorkflow(harness);

    expect(result.subprocess.exitCode).toBe(0);
    expect(harness.calls.transitions).toEqual([
      "generating",
      "executing",
      "validating",
      "reviewing",
      "complete",
    ]);
  });

  it("re-enters the writer loop when reviewer feedback requests another revision", async () => {
    const harness = createHarness({
      reviewOutcomes: [
        { status: "revise", revisionBrief: "补强问题背景，并把结论改得更像中文文章。" },
        { status: "completed" },
      ],
    });

    const result = await runWorkflow(harness);

    expect(result.subprocess.exitCode).toBe(0);
    expect(harness.calls.spawns).toEqual(["session-1", "session-1"]);
    expect(harness.calls.validations).toEqual([
      `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
      `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
    ]);
    expect(harness.calls.reviews).toEqual([
      `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
      `/tmp/.output/session-mind/${SessionMindOutputPaths.draftsDirectory}/session-1.md`,
    ]);
    expect(harness.calls.transitions).toEqual([
      "generating",
      "executing",
      "validating",
      "reviewing",
      "generating",
      "executing",
      "validating",
      "reviewing",
      "complete",
    ]);
  });
});
