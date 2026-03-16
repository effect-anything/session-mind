import { Effect, Exit, Option } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStateManager } from "../src/services/WorkflowStateManager.ts";

const tempDirectories: Array<string> = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-mind-workflow-state-"));
  tempDirectories.push(directory);
  return directory;
};

const runWithWorkflowStateManager = <A, E>(
  effect: Effect.Effect<A, E, WorkflowStateManager>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(WorkflowStateManager.layer)));

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkflowStateManager", () => {
  it("persists workflow transitions atomically to the state file", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-1",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-1",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-1",
          nextStage: "executing",
          promptBundlePath: join(rootDirectory, "prompt.json"),
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-1",
          nextStage: "validating",
        });

        const completeState = yield* manager.transition({
          stateFilePath,
          sessionId: "session-1",
          nextStage: "complete",
        });

        expect(completeState.stage).toBe("complete");
        expect(completeState.articleStatus).toBe("draft");
        expect(completeState.retryCount).toBe(0);
        expect(completeState.iteration).toBe(1);

        const stateFileContent = yield* Effect.tryPromise(() => readFile(stateFilePath, "utf8"));
        expect(stateFileContent).toContain('"version": 1');
        expect(stateFileContent).toContain('"stage": "complete"');
        expect(stateFileContent).not.toContain(".tmp");
      }),
    );
  });

  it("rejects invalid workflow transitions", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-2",
          artifactPath,
        });

        const exit = yield* Effect.exit(
          manager.transition({
            stateFilePath,
            sessionId: "session-2",
            nextStage: "validating",
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Exit.findErrorOption(exit);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            const error = failure.value as { readonly _tag: string; readonly code: string };
            expect(error._tag).toBe("StateError");
            expect(error.code).toBe("STATE_TRANSITION_INVALID");
          }
        }
      }),
    );
  });

  it("recovers resumable workflows from persisted state", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-3",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-3",
          nextStage: "generating",
        });

        const recovery = yield* manager.recoverSession(stateFilePath, "session-3");

        expect(recovery.action).toBe("resume");
        if (recovery.action === "resume") {
          expect(recovery.nextStage).toBe("generating");
          expect(recovery.state.sessionId).toBe("session-3");
        }
      }),
    );
  });

  it("reopens completed drafts by resuming at generating", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-reopen",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-reopen",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-reopen",
          nextStage: "executing",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-reopen",
          nextStage: "validating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-reopen",
          nextStage: "complete",
        });

        const recovery = yield* manager.recoverSession(stateFilePath, "session-reopen");

        expect(recovery.action).toBe("resume");
        if (recovery.action === "resume") {
          expect(recovery.nextStage).toBe("generating");
          expect(recovery.state.articleStatus).toBe("draft");
        }
      }),
    );
  });

  it("treats published articles as immutable complete items until moved back to draft", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "draft.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-published",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-published",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-published",
          nextStage: "executing",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-published",
          nextStage: "validating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-published",
          nextStage: "complete",
        });

        yield* manager.setArticleStatus({
          stateFilePath,
          sessionId: "session-published",
          articleStatus: "published",
          artifactPath: join(rootDirectory, "published.md"),
        });

        const recovery = yield* manager.recoverSession(stateFilePath, "session-published");

        expect(recovery.action).toBe("complete");
        if (recovery.action === "complete") {
          expect(recovery.state.articleStatus).toBe("published");
          expect(recovery.state.artifactPath).toBe(join(rootDirectory, "published.md"));
        }
      }),
    );
  });

  it("retries failed validation runs from executing so the artifact can be regenerated", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-4",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-4",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-4",
          nextStage: "executing",
          promptBundlePath: join(rootDirectory, "prompt.json"),
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-4",
          nextStage: "validating",
        });

        yield* manager.markFailure({
          stateFilePath,
          sessionId: "session-4",
          message: "Generated artifact was too short",
        });

        const recovery = yield* manager.recoverSession(stateFilePath, "session-4");

        expect(recovery.action).toBe("resume");
        if (recovery.action === "resume") {
          expect(recovery.nextStage).toBe("executing");
          expect(recovery.state.stage).toBe("failed");
          expect(recovery.state.lastStableStage).toBe("validating");
          expect(recovery.state.retryCount).toBe(1);
        }
      }),
    );
  });

  it("allows validation failures to move back to generating for the next loop iteration", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-loop",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-loop",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-loop",
          nextStage: "executing",
          promptBundlePath: join(rootDirectory, "prompt.json"),
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-loop",
          nextStage: "validating",
        });

        const nextIteration = yield* manager.transition({
          stateFilePath,
          sessionId: "session-loop",
          nextStage: "generating",
          iteration: 2,
          lastValidationIssues: ["Artifact content must be at least 200 characters."],
        });

        expect(nextIteration.stage).toBe("generating");
        expect(nextIteration.iteration).toBe(2);
        expect(nextIteration.lastValidationIssues).toEqual([
          "Artifact content must be at least 200 characters.",
        ]);
      }),
    );
  });

  it("allows reviewer feedback to reopen generation for another article pass", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-review-loop",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-review-loop",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-review-loop",
          nextStage: "executing",
          promptBundlePath: join(rootDirectory, "prompt.json"),
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-review-loop",
          nextStage: "validating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-review-loop",
          nextStage: "reviewing",
        });

        const nextIteration = yield* manager.transition({
          stateFilePath,
          sessionId: "session-review-loop",
          nextStage: "generating",
          iteration: 2,
          lastValidationIssues: ["Reviewer revision brief: 重写标题和开头，减少口语化表达。"],
        });

        expect(nextIteration.stage).toBe("generating");
        expect(nextIteration.iteration).toBe(2);
        expect(nextIteration.lastStableStage).toBe("generating");
        expect(nextIteration.lastValidationIssues).toEqual([
          "Reviewer revision brief: 重写标题和开头，减少口语化表达。",
        ]);
      }),
    );
  });

  it("resets retryCount after a successful completion so future failures can recover normally", async () => {
    await runWithWorkflowStateManager(
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const rootDirectory = yield* Effect.tryPromise(() => createTempDirectory());
        const stateFilePath = join(rootDirectory, "state.json");
        const artifactPath = join(rootDirectory, "artifact.md");

        yield* manager.initializeSession({
          stateFilePath,
          sessionId: "session-retry-reset",
          artifactPath,
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "executing",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "validating",
        });

        const failed = yield* manager.markFailure({
          stateFilePath,
          sessionId: "session-retry-reset",
          message: "first failure",
        });
        expect(failed.retryCount).toBe(1);

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "executing",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "validating",
        });

        const complete = yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "complete",
        });
        expect(complete.retryCount).toBe(0);

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "generating",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "executing",
        });

        yield* manager.transition({
          stateFilePath,
          sessionId: "session-retry-reset",
          nextStage: "validating",
        });

        const failedAgain = yield* manager.markFailure({
          stateFilePath,
          sessionId: "session-retry-reset",
          message: "second failure",
        });
        expect(failedAgain.retryCount).toBe(1);

        const recovery = yield* manager.recoverSession(stateFilePath, "session-retry-reset");
        expect(recovery.action).toBe("resume");
        if (recovery.action === "resume") {
          expect(recovery.nextStage).toBe("executing");
          expect(recovery.state.retryCount).toBe(1);
        }
      }),
    );
  });
});
