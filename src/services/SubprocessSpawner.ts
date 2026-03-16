import { NodeServices } from "@effect/platform-node";
import { join } from "node:path";
import {
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Ref,
  ServiceMap,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PromptBundle } from "../domain/Session";
import {
  SessionMindOutputPaths,
  SubprocessEnvironmentVariable,
  SubprocessExitCode,
} from "../domain/SubprocessProtocol";
import { SubprocessError } from "../domain/SessionMindErrors";

export type SpawnSubprocessRequest = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sessionId: string;
  readonly promptBundle: PromptBundle;
  readonly outputDir: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
};

export type SpawnSubprocessResult = {
  readonly sessionId: string;
  readonly artifactPath: string;
  readonly promptBundlePath: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const defaultTimeoutMs = 30 * 60 * 1000;
const killGracePeriod = Duration.seconds(1);

const isSubprocessError = (cause: unknown): cause is SubprocessError =>
  cause instanceof SubprocessError ||
  (typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "SubprocessError");

const buildContext = ({
  command,
  args,
  cwd,
  sessionId,
  outputDir,
  timeoutMs,
  details,
  exitCode,
}: SpawnSubprocessRequest & {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly exitCode?: number;
}) => ({
  command,
  args: [...args],
  cwd,
  sessionId,
  outputDir,
  timeoutMs,
  ...(exitCode !== undefined ? { exitCode } : {}),
  ...(details !== undefined ? { details } : {}),
});

const withCapturedOutput = (
  error: SubprocessError,
  output: { readonly stdout: string; readonly stderr: string },
): SubprocessError => {
  if (output.stdout === "" && output.stderr === "") {
    return error;
  }

  return new SubprocessError({
    code: error.code,
    message: error.message,
    context: {
      ...error.context,
      details: {
        ...error.context.details,
        ...(output.stdout === "" ? {} : { stdout: output.stdout }),
        ...(output.stderr === "" ? {} : { stderr: output.stderr }),
      },
    },
  });
};

export class SubprocessSpawner extends ServiceMap.Service<
  SubprocessSpawner,
  {
    spawn(
      request: SpawnSubprocessRequest,
    ): Effect.Effect<SpawnSubprocessResult, SubprocessError>;
  }
>()("session-mind/SubprocessSpawner") {
  static readonly layer = Layer.effect(
    SubprocessSpawner,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const spawn: (
        request: SpawnSubprocessRequest,
      ) => Effect.Effect<SpawnSubprocessResult, SubprocessError> = Effect.fn(
        "SubprocessSpawner.spawn",
      )(function* ({
        command,
        args,
        cwd,
        sessionId,
        promptBundle,
        outputDir,
        timeoutMs = defaultTimeoutMs,
        env,
      }: SpawnSubprocessRequest) {
        const articlesDir = join(outputDir, SessionMindOutputPaths.articlesDirectory);
        const bundlesDir = join(outputDir, SessionMindOutputPaths.bundlesDirectory);
        const artifactPath = join(articlesDir, `${sessionId}.md`);
        const promptBundlePath = join(bundlesDir, `${sessionId}.prompt.json`);
        const serializedPromptBundle = JSON.stringify(promptBundle);
        const request = {
          command,
          args,
          cwd,
          sessionId,
          promptBundle,
          outputDir,
          timeoutMs,
          ...(env !== undefined ? { env } : {}),
        } satisfies SpawnSubprocessRequest;

        yield* Effect.all([
          fs.makeDirectory(articlesDir, { recursive: true }),
          fs.makeDirectory(bundlesDir, { recursive: true }),
        ]).pipe(
          Effect.mapError(
            (cause) =>
              new SubprocessError({
                code: "SUBPROCESS_IO_FAILED",
                message: "Failed to prepare subprocess output directories",
                context: buildContext({
                  ...request,
                  details: { cause: String(cause) },
                }),
              }),
          ),
        );

        yield* fs.writeFileString(promptBundlePath, JSON.stringify(promptBundle, null, 2)).pipe(
          Effect.mapError(
            (cause) =>
              new SubprocessError({
                code: "SUBPROCESS_IO_FAILED",
                message: "Failed to persist the prompt bundle for the subprocess",
                context: buildContext({
                  ...request,
                  details: {
                    cause: String(cause),
                    promptBundlePath,
                  },
                }),
              }),
          ),
        );

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, [...args], {
                cwd,
                env: {
                  ...env,
                  [SubprocessEnvironmentVariable.promptBundle]: serializedPromptBundle,
                  [SubprocessEnvironmentVariable.outputDir]: outputDir,
                  [SubprocessEnvironmentVariable.sessionId]: sessionId,
                  [SubprocessEnvironmentVariable.timeoutSeconds]: String(
                    Math.max(1, Math.ceil(timeoutMs / 1000)),
                  ),
                },
                extendEnv: true,
                stdin: "ignore",
                stdout: "pipe",
                stderr: "pipe",
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new SubprocessError({
                    code: "SUBPROCESS_SPAWN_FAILED",
                    message: "Failed to start subprocess",
                    context: buildContext({
                      ...request,
                      details: { cause: String(cause) },
                    }),
                  }),
              ),
            );

            const stdoutRef = yield* Ref.make("");
            const stderrRef = yield* Ref.make("");

            const stdoutFiber = yield* handle.stdout.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Ref.update(stdoutRef, (stdout) => `${stdout}${chunk}`),
              ),
              Effect.forkChild,
            );

            const stderrFiber = yield* handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`),
              ),
              Effect.forkChild,
            );

            const bestEffortOutput = Effect.gen(function* () {
              yield* Fiber.await(stdoutFiber);
              yield* Fiber.await(stderrFiber);

              return {
                stdout: yield* Ref.get(stdoutRef),
                stderr: yield* Ref.get(stderrRef),
              } as const;
            });

            const readOutput = Effect.gen(function* () {
              yield* Fiber.join(stdoutFiber).pipe(
                Effect.mapError(
                  (cause) =>
                    new SubprocessError({
                      code: "SUBPROCESS_IO_FAILED",
                      message: "Failed to capture subprocess stdout",
                      context: buildContext({
                        ...request,
                        details: { cause: String(cause) },
                      }),
                    }),
                ),
              );

              yield* Fiber.join(stderrFiber).pipe(
                Effect.mapError(
                  (cause) =>
                    new SubprocessError({
                      code: "SUBPROCESS_IO_FAILED",
                      message: "Failed to capture subprocess stderr",
                      context: buildContext({
                        ...request,
                        details: { cause: String(cause) },
                      }),
                    }),
                ),
              );

              return {
                stdout: yield* Ref.get(stdoutRef),
                stderr: yield* Ref.get(stderrRef),
              } as const;
            });

            const exitCode = yield* handle.exitCode.pipe(
              Effect.map(Number),
              Effect.timeout(Duration.millis(timeoutMs)),
              Effect.catchTag("TimeoutError", () =>
                handle.kill({
                  killSignal: "SIGTERM",
                  forceKillAfter: killGracePeriod,
                }).pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(
                    Effect.fail(
                      new SubprocessError({
                        code: "SUBPROCESS_TIMED_OUT",
                        message: "Subprocess exceeded the configured timeout",
                        context: buildContext(request),
                      }),
                    ),
                  ),
                ),
              ),
              Effect.mapError((cause) =>
                isSubprocessError(cause)
                  ? cause
                  : new SubprocessError({
                      code: "SUBPROCESS_SPAWN_FAILED",
                      message: "Failed while waiting for subprocess completion",
                      context: buildContext({
                        ...request,
                        details: { cause: String(cause) },
                      }),
                    }),
              ),
              Effect.catch((error) =>
                bestEffortOutput.pipe(
                  Effect.flatMap((output) => Effect.fail(withCapturedOutput(error, output))),
                ),
              ),
            );

            const output = yield* readOutput;

            if (exitCode !== SubprocessExitCode.success) {
              return yield* new SubprocessError({
                code: "SUBPROCESS_EXITED_NON_ZERO",
                message: "Subprocess exited with a non-zero status",
                context: buildContext({
                  ...request,
                  exitCode,
                  details: output,
                }),
              });
            }

            const artifactExists = yield* fs.exists(artifactPath).pipe(
              Effect.mapError(
                (cause) =>
                  new SubprocessError({
                    code: "SUBPROCESS_IO_FAILED",
                    message: "Failed to verify subprocess artifact output",
                    context: buildContext({
                      ...request,
                      exitCode,
                      details: {
                        cause: String(cause),
                        artifactPath,
                        ...output,
                      },
                    }),
                  }),
              ),
            );

            if (!artifactExists) {
              return yield* new SubprocessError({
                code: "SUBPROCESS_PROTOCOL_VIOLATION",
                message: "Subprocess exited successfully without writing the expected artifact",
                context: buildContext({
                  ...request,
                  exitCode,
                  details: {
                    artifactPath,
                    promptBundlePath,
                    ...output,
                  },
                }),
              });
            }

            return {
              sessionId,
              artifactPath,
              promptBundlePath,
              exitCode,
              stdout: output.stdout,
              stderr: output.stderr,
            } satisfies SpawnSubprocessResult;
          }),
        );
      });

      return SubprocessSpawner.of({ spawn });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}
