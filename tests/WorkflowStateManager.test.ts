import { describe, expect, it } from "@effect/vitest";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Effect, Exit, FileSystem, Layer, Option, Path } from "effect";
import { WorkflowStateManager, WORKFLOW_MAX_RETRIES } from "../src/services/WorkflowStateManager";

const withTempWorkflowRoot = <A, E>(
  f: (rootDirectory: string) => Effect.Effect<A, E, WorkflowStateManager | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const rootDirectory = yield* fs.makeTempDirectory({
      prefix: "session-mind-workflow-state-",
    });

    return yield* f(rootDirectory).pipe(
      Effect.provide(WorkflowStateManager.layerAt({ rootDirectory }), { local: true }),
      Effect.ensuring(
        fs.remove(rootDirectory, { recursive: true, force: true }).pipe(Effect.orDie),
      ),
    );
  }).pipe(
    Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer), { local: true }),
  );

describe("WorkflowStateManager", () => {
  it.effect("persists workflow transitions atomically to the state file", () =>
    withTempWorkflowRoot((rootDirectory) =>
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const fs = yield* FileSystem.FileSystem;

        yield* manager.startWorkflow("session-1", "Extract");
        yield* manager.transition("session-1", "generating", {
          currentStep: "Generate prompt bundle",
        });
        yield* manager.transition("session-1", "executing", {
          currentStep: "Run writing agent",
          artifacts: {
            promptBundle: ".output/session-mind/sessions/session-1/prompt-bundle.json",
          },
        });
        yield* manager.transition("session-1", "validating", {
          currentStep: "Validate generated article",
          artifacts: {
            generatedArticle: ".output/session-mind/sessions/session-1/output/session-1.md",
          },
        });
        const completeState = yield* manager.transition("session-1", "complete", {
          currentStep: "Workflow complete",
        });

        expect(completeState.status).toBe("complete");
        expect(completeState.retryCount).toBe(0);
        expect(completeState.completedAt).toBeTypeOf("number");

        const stateFilePath = manager.getStateFilePath();
        const stateFileContent = yield* fs.readFileString(stateFilePath);

        expect(stateFilePath).toContain(
          `${rootDirectory}/.output/session-mind/state.json`,
        );
        expect(stateFileContent).toContain("\"version\": 1");
        expect(stateFileContent).toContain("\"status\": \"complete\"");
        expect(stateFileContent).not.toContain(".tmp");
      }),
    ));

  it.effect("rejects invalid workflow transitions", () =>
    withTempWorkflowRoot(() =>
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;

        yield* manager.startWorkflow("session-2", "Extract");
        const exit = yield* Effect.exit(
          manager.transition("session-2", "validating", {
            currentStep: "Validate before execution",
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const failure = Exit.findErrorOption(exit);
          expect(Option.isSome(failure)).toBe(true);
          if (Option.isSome(failure)) {
            expect(failure.value._tag).toBe("StateError");
            expect(failure.value.code).toBe("invalid-transition");
            expect(failure.value.currentStatus).toBe("extracting");
            expect(failure.value.nextStatus).toBe("validating");
          }
        }
      }),
    ));

  it.effect("recovers resumable workflows from persisted state", () =>
    withTempWorkflowRoot((rootDirectory) =>
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const generatedArticlePath = path.join(
          rootDirectory,
          ".output",
          "session-mind",
          "sessions",
          "session-3",
          "output",
          "session-3.md",
        );

        yield* fs.makeDirectory(path.dirname(generatedArticlePath), { recursive: true });
        yield* fs.writeFileString(generatedArticlePath, "# article");

        yield* manager.startWorkflow("session-3", "Extract");
        yield* manager.transition("session-3", "generating", {
          currentStep: "Generate prompt bundle",
        });
        yield* manager.transition("session-3", "executing", {
          currentStep: "Run writing agent",
          artifacts: {
            generatedArticle: generatedArticlePath,
          },
        });

        yield* manager.startWorkflow("session-4", "Extract");
        yield* manager.transition("session-4", "generating", {
          currentStep: "Generate prompt bundle",
        });
        yield* manager.transition("session-4", "executing", {
          currentStep: "Run writing agent",
        });
        yield* manager.transition("session-4", "validating", {
          currentStep: "Validate article",
        });

        const recoveries = yield* manager.recoverWorkflows();
        const recoveryBySessionId = new Map(
          recoveries.map((recovery) => [recovery.sessionId, recovery]),
        );

        expect(recoveryBySessionId.get("session-3")?.resumeFromStatus).toBe("validating");
        expect(recoveryBySessionId.get("session-3")?.action).toBe("resume-validation");
        expect(recoveryBySessionId.get("session-4")?.resumeFromStatus).toBe("executing");
        expect(recoveryBySessionId.get("session-4")?.reason).toContain("artifact is missing");
      }),
    ));

  it.effect("tracks transient retries and marks the workflow failed when retries are exhausted", () =>
    withTempWorkflowRoot(() =>
      Effect.gen(function* () {
        const manager = yield* WorkflowStateManager;

        yield* manager.startWorkflow("session-5", "Extract");
        yield* manager.transition("session-5", "generating", {
          currentStep: "Generate prompt bundle",
        });

        for (let index = 1; index <= WORKFLOW_MAX_RETRIES; index += 1) {
          const result = yield* manager.recordTransientFailure("session-5", {
            code: "temporary-io",
            message: `Temporary failure ${index}`,
            details: { attempt: index },
          });

          expect(result.shouldRetry).toBe(true);
          expect(result.state.status).toBe("generating");
          expect(result.state.retryCount).toBe(index);
        }

        const exhausted = yield* manager.recordTransientFailure("session-5", {
          code: "temporary-io",
          message: "Final transient failure",
        });
        const persistedState = yield* manager.getState("session-5");

        expect(exhausted.shouldRetry).toBe(false);
        expect(exhausted.attemptsRemaining).toBe(0);
        expect(exhausted.state.status).toBe("failed");
        expect(Option.isSome(persistedState)).toBe(true);
        if (Option.isSome(persistedState)) {
          expect(persistedState.value.status).toBe("failed");
          expect(persistedState.value.error?.message).toBe("Final transient failure");
        }
      }),
    ));
});
