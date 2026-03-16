import { describe, expect, layer } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { WorkflowStateManager } from "../src/services/WorkflowStateManager";

const tempDirectories: Array<string> = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-mind-workflow-state-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkflowStateManager", () => {
  layer(WorkflowStateManager.layer)((it) => {
    it.effect(
      "persists workflow transitions atomically to the state file",
      Effect.fn(function* () {
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

    it.effect(
      "rejects invalid workflow transitions",
      Effect.fn(function* () {
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
            expect(failure.value._tag).toBe("StateError");
            expect(failure.value.code).toBe("STATE_TRANSITION_INVALID");
          }
        }
      }),
    );

    it.effect(
      "recovers resumable workflows from persisted state",
      Effect.fn(function* () {
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
});
