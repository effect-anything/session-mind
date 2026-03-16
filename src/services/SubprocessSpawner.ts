import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Effect, Layer, ServiceMap } from "effect";
import type { PromptBundle } from "../domain/Session";
import {
  SessionMindEnvironmentVariables,
  SessionMindExitCodes,
  SessionMindOutputPaths,
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

export class SubprocessSpawner extends ServiceMap.Service<
  SubprocessSpawner,
  {
    spawn(
      request: SpawnSubprocessRequest,
    ): Effect.Effect<SpawnSubprocessResult, SubprocessError>;
  }
>()("session-mind/SubprocessSpawner") {
  static readonly layer = Layer.succeed(
    SubprocessSpawner,
    SubprocessSpawner.of({
      spawn: Effect.fn("SubprocessSpawner.spawn")(function* ({
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

        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(articlesDir, { recursive: true });
            await mkdir(bundlesDir, { recursive: true });
            await writeFile(promptBundlePath, JSON.stringify(promptBundle, null, 2), "utf8");
          },
          catch: (cause) =>
            new SubprocessError({
              code: "SUBPROCESS_IO_FAILED",
              message: "Failed to prepare subprocess IO artifacts",
              context: {
                command,
                args: [...args],
                cwd,
                sessionId,
                outputDir,
                timeoutMs,
                details: { cause: String(cause) },
              },
            }),
        });

        const result = yield* Effect.tryPromise({
          try: () =>
            new Promise<SpawnSubprocessResult>((resolve, reject) => {
              let stdout = "";
              let stderr = "";
              let settled = false;

              const child = spawn(command, [...args], {
                cwd,
                env: {
                  ...process.env,
                  ...env,
                  [SessionMindEnvironmentVariables.promptBundle]: JSON.stringify(promptBundle),
                  [SessionMindEnvironmentVariables.outputDir]: outputDir,
                  [SessionMindEnvironmentVariables.sessionId]: sessionId,
                  [SessionMindEnvironmentVariables.timeoutSeconds]: String(
                    Math.max(1, Math.ceil(timeoutMs / 1000)),
                  ),
                },
                stdio: ["ignore", "pipe", "pipe"],
              });

              child.stdout?.on("data", (chunk) => {
                stdout += chunk.toString();
              });

              child.stderr?.on("data", (chunk) => {
                stderr += chunk.toString();
              });

              const timer = setTimeout(() => {
                if (settled) {
                  return;
                }

                settled = true;
                child.kill("SIGKILL");
                reject(
                  new SubprocessError({
                    code: "SUBPROCESS_TIMED_OUT",
                    message: "Subprocess exceeded the configured timeout",
                    context: {
                      command,
                      args: [...args],
                      cwd,
                      sessionId,
                      outputDir,
                      timeoutMs,
                    },
                  }),
                );
              }, timeoutMs);

              child.once("error", (cause) => {
                if (settled) {
                  return;
                }

                settled = true;
                clearTimeout(timer);
                reject(
                  new SubprocessError({
                    code: "SUBPROCESS_SPAWN_FAILED",
                    message: "Failed to start subprocess",
                    context: {
                      command,
                      args: [...args],
                      cwd,
                      sessionId,
                      outputDir,
                      timeoutMs,
                      details: { cause: String(cause) },
                    },
                  }),
                );
              });

              child.once("close", (exitCode, signal) => {
                if (settled) {
                  return;
                }

                settled = true;
                clearTimeout(timer);

                if (exitCode === SessionMindExitCodes.success) {
                  resolve({
                    sessionId,
                    artifactPath,
                    promptBundlePath,
                    exitCode: exitCode ?? 0,
                    stdout,
                    stderr,
                  });
                  return;
                }

                reject(
                  new SubprocessError({
                    code: "SUBPROCESS_EXITED_NON_ZERO",
                    message: "Subprocess exited with a non-zero status",
                    context: {
                      command,
                      args: [...args],
                      cwd,
                      sessionId,
                      outputDir,
                      exitCode: exitCode ?? SessionMindExitCodes.error,
                      ...(signal !== null ? { signal } : {}),
                      timeoutMs,
                      details: {
                        stdout,
                        stderr,
                      },
                    },
                  }),
                );
              });
            }),
          catch: (cause) =>
            cause instanceof SubprocessError
              ? cause
              : new SubprocessError({
                  code: "SUBPROCESS_SPAWN_FAILED",
                  message: "Subprocess failed before producing a result",
                  context: {
                    command,
                    args: [...args],
                    cwd,
                    sessionId,
                    outputDir,
                    timeoutMs,
                    details: { cause: String(cause) },
                  },
                }),
        });

        return result;
      }),
    }),
  );
}
