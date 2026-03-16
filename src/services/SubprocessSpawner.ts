import { NodeServices } from "@effect/platform-node";
import { join } from "node:path";
import {
  Duration,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  ServiceMap,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { parseSessionIdentifier, type PromptBundle } from "../domain/Session.ts";
import {
  SessionMindOutputPaths,
  SubprocessEnvironmentVariable,
  SubprocessExitCode,
  SubprocessPromptBundleJsonSchema,
  SubprocessPromptBundlePrettyJsonSchema,
} from "../domain/SubprocessProtocol.ts";
import { SubprocessError } from "../domain/SessionMindErrors.ts";
import {
  type WriterRevisionContext,
  buildWriterTask,
  resolveWriterPromptArgs,
} from "./WriterTaskBuilder.ts";

export type SpawnSubprocessRequest = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly sessionId: string;
  readonly promptBundle: PromptBundle;
  readonly outputDir: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdioMode?: "capture" | "foreground";
  readonly iteration?: number;
  readonly revision?: WriterRevisionContext;
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

const artifactBackupSuffix = "previous-run";

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

const toArtifactFingerprint = (info: FileSystem.File.Info) =>
  `${Option.match(info.mtime, {
    onNone: () => 0,
    onSome: (mtime) => mtime.getTime(),
  })}:${String(info.size)}`;

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

const encodePromptBundle = ({
  command,
  args,
  cwd,
  sessionId,
  promptBundle,
  outputDir,
  timeoutMs,
  promptBundlePath,
}: Omit<SpawnSubprocessRequest, "timeoutMs"> & {
  readonly timeoutMs: number;
  readonly promptBundlePath: string;
}) =>
  Effect.all({
    envValue: Schema.encodeEffect(SubprocessPromptBundleJsonSchema)(promptBundle),
    persistedValue: Schema.encodeEffect(SubprocessPromptBundlePrettyJsonSchema)(promptBundle),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SubprocessError({
          code: "SUBPROCESS_PROTOCOL_VIOLATION",
          message: "Failed to encode the prompt bundle for subprocess transport",
          context: buildContext({
            command,
            args,
            cwd,
            sessionId,
            promptBundle,
            outputDir,
            timeoutMs,
            details: {
              cause: String(cause),
              promptBundlePath,
            },
          }),
        }),
    ),
  );

export class SubprocessSpawner extends ServiceMap.Service<
  SubprocessSpawner,
  {
    spawn(request: SpawnSubprocessRequest): Effect.Effect<SpawnSubprocessResult, SubprocessError>;
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
        stdioMode = "capture",
        iteration = 1,
        revision,
      }: SpawnSubprocessRequest) {
        const identifier = parseSessionIdentifier(sessionId);
        const articlesDir = join(
          outputDir,
          SessionMindOutputPaths.draftsDirectory,
          identifier.source,
        );
        const bundlesDir = join(
          outputDir,
          SessionMindOutputPaths.bundlesDirectory,
          identifier.source,
        );
        const artifactPath = join(articlesDir, `${identifier.nativeId}.md`);
        const backupArtifactPath = join(
          articlesDir,
          `${identifier.nativeId}.${artifactBackupSuffix}.${iteration}.md`,
        );
        const promptBundlePath = join(bundlesDir, `${identifier.nativeId}.prompt.json`);
        if (stdioMode === "foreground" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
          return yield* new SubprocessError({
            code: "SUBPROCESS_IO_FAILED",
            message: "Foreground subprocess mode requires an interactive terminal",
            context: buildContext({
              command,
              args,
              cwd,
              sessionId,
              promptBundle,
              outputDir,
              timeoutMs,
              stdioMode,
              iteration,
              ...(revision !== undefined ? { revision } : {}),
              ...(env !== undefined ? { env } : {}),
              details: {
                stdinIsTTY: Boolean(process.stdin.isTTY),
                stdoutIsTTY: Boolean(process.stdout.isTTY),
              },
            }),
          });
        }
        const request = {
          command,
          args,
          cwd,
          sessionId,
          promptBundle,
          outputDir,
          timeoutMs,
          stdioMode,
          iteration,
          ...(revision !== undefined ? { revision } : {}),
          ...(env !== undefined ? { env } : {}),
        } satisfies SpawnSubprocessRequest;
        const serializedPromptBundle = yield* encodePromptBundle({
          ...request,
          promptBundlePath,
        });

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

        yield* fs.writeFileString(promptBundlePath, serializedPromptBundle.persistedValue).pipe(
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
            const artifactCommitted = yield* Ref.make(false);
            const preparedArtifact = yield* Effect.acquireRelease(
              Effect.gen(function* () {
                const artifactExists = yield* fs.exists(artifactPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new SubprocessError({
                        code: "SUBPROCESS_IO_FAILED",
                        message: "Failed to inspect existing artifact before spawning subprocess",
                        context: buildContext({
                          ...request,
                          details: { cause: String(cause), artifactPath },
                        }),
                      }),
                  ),
                );

                if (!artifactExists) {
                  return {
                    backupPath: null,
                    previousFingerprint: null,
                    effectiveRevision: revision,
                  } as const;
                }

                const previousArtifactInfo = yield* fs.stat(artifactPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new SubprocessError({
                        code: "SUBPROCESS_IO_FAILED",
                        message: "Failed to inspect existing artifact metadata",
                        context: buildContext({
                          ...request,
                          details: { cause: String(cause), artifactPath },
                        }),
                      }),
                  ),
                );

                yield* fs
                  .remove(backupArtifactPath, { force: true })
                  .pipe(Effect.catch(() => Effect.void));

                yield* fs.rename(artifactPath, backupArtifactPath).pipe(
                  Effect.mapError(
                    (cause) =>
                      new SubprocessError({
                        code: "SUBPROCESS_IO_FAILED",
                        message: "Failed to move the previous artifact out of the way",
                        context: buildContext({
                          ...request,
                          details: {
                            cause: String(cause),
                            artifactPath,
                            backupArtifactPath,
                          },
                        }),
                      }),
                  ),
                );

                return {
                  backupPath: backupArtifactPath,
                  previousFingerprint: toArtifactFingerprint(previousArtifactInfo),
                  effectiveRevision:
                    revision === undefined
                      ? undefined
                      : {
                          ...revision,
                          previousArtifactPath: backupArtifactPath,
                        },
                } as const;
              }),
              ({ backupPath }) =>
                backupPath === null
                  ? Effect.void
                  : Effect.gen(function* () {
                      const committed = yield* Ref.get(artifactCommitted);
                      if (committed) {
                        yield* fs
                          .remove(backupPath, { force: true })
                          .pipe(Effect.catch(() => Effect.void));
                        return;
                      }

                      yield* fs
                        .remove(artifactPath, { force: true })
                        .pipe(Effect.catch(() => Effect.void));
                      yield* fs
                        .rename(backupPath, artifactPath)
                        .pipe(Effect.catch(() => Effect.void));
                    }),
            );
            const writerTask = buildWriterTask({
              sessionId,
              outputDir,
              promptBundle,
              iteration,
              ...(preparedArtifact.effectiveRevision !== undefined
                ? { revision: preparedArtifact.effectiveRevision }
                : {}),
            });
            const resolvedArgs = resolveWriterPromptArgs(args, writerTask);
            const handle = yield* spawner
              .spawn(
                ChildProcess.make(command, [...resolvedArgs], {
                  cwd,
                  env: {
                    ...env,
                    [SubprocessEnvironmentVariable.promptBundle]: serializedPromptBundle.envValue,
                    [SubprocessEnvironmentVariable.outputDir]: outputDir,
                    [SubprocessEnvironmentVariable.sessionId]: sessionId,
                    [SubprocessEnvironmentVariable.timeoutSeconds]: String(
                      Math.max(1, Math.ceil(timeoutMs / 1000)),
                    ),
                  },
                  extendEnv: true,
                  stdin: stdioMode === "foreground" ? "inherit" : "ignore",
                  stdout: stdioMode === "foreground" ? "inherit" : "pipe",
                  stderr: stdioMode === "foreground" ? "inherit" : "pipe",
                }),
              )
              .pipe(
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

            const outputRefs = yield* Effect.all({
              stdoutRef: Ref.make(""),
              stderrRef: Ref.make(""),
            });

            const outputCapture =
              stdioMode === "foreground"
                ? null
                : {
                    stdoutFiber: yield* handle.stdout.pipe(
                      Stream.decodeText(),
                      Stream.runForEach((chunk) =>
                        Ref.update(outputRefs.stdoutRef, (stdout) => `${stdout}${chunk}`),
                      ),
                      Effect.forkChild,
                    ),
                    stderrFiber: yield* handle.stderr.pipe(
                      Stream.decodeText(),
                      Stream.runForEach((chunk) =>
                        Ref.update(outputRefs.stderrRef, (stderr) => `${stderr}${chunk}`),
                      ),
                      Effect.forkChild,
                    ),
                  };

            const bestEffortOutput =
              outputCapture === null
                ? Effect.succeed({ stdout: "", stderr: "" } as const)
                : Effect.gen(function* () {
                    yield* Fiber.await(outputCapture.stdoutFiber);
                    yield* Fiber.await(outputCapture.stderrFiber);

                    return {
                      stdout: yield* Ref.get(outputRefs.stdoutRef),
                      stderr: yield* Ref.get(outputRefs.stderrRef),
                    } as const;
                  });

            const readOutput =
              outputCapture === null
                ? Effect.succeed({ stdout: "", stderr: "" } as const)
                : Effect.gen(function* () {
                    yield* Fiber.join(outputCapture.stdoutFiber).pipe(
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

                    yield* Fiber.join(outputCapture.stderrFiber).pipe(
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
                      stdout: yield* Ref.get(outputRefs.stdoutRef),
                      stderr: yield* Ref.get(outputRefs.stderrRef),
                    } as const;
                  });

            const exitCode = yield* handle.exitCode.pipe(
              Effect.map(Number),
              Effect.timeout(Duration.millis(timeoutMs)),
              Effect.catchTag("TimeoutError", () =>
                handle
                  .kill({
                    killSignal: "SIGTERM",
                    forceKillAfter: killGracePeriod,
                  })
                  .pipe(
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

            if (preparedArtifact.previousFingerprint !== null) {
              const currentArtifactInfo = yield* fs.stat(artifactPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new SubprocessError({
                      code: "SUBPROCESS_IO_FAILED",
                      message: "Failed to inspect generated artifact metadata",
                      context: buildContext({
                        ...request,
                        exitCode,
                        details: {
                          cause: String(cause),
                          artifactPath,
                          promptBundlePath,
                          ...output,
                        },
                      }),
                    }),
                ),
              );

              if (
                preparedArtifact.previousFingerprint === toArtifactFingerprint(currentArtifactInfo)
              ) {
                return yield* new SubprocessError({
                  code: "SUBPROCESS_PROTOCOL_VIOLATION",
                  message: "Subprocess exited successfully without updating the artifact output",
                  context: buildContext({
                    ...request,
                    exitCode,
                    details: {
                      artifactPath,
                      promptBundlePath,
                      backupArtifactPath: preparedArtifact.backupPath,
                      ...output,
                    },
                  }),
                });
              }
            }

            yield* Ref.set(artifactCommitted, true);

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
