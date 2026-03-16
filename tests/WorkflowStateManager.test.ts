import { Effect, Exit, Option } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowStateManager } from "../src/services/WorkflowStateManager";

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
        expect(completeState.retryCount).toBe(0);

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
});
