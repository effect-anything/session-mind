import { NodeServices } from "@effect/platform-node";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Duration, Effect, Fiber, Layer, Ref, ServiceMap, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { SubprocessError } from "../domain/SessionMindErrors.ts";
import { AgentResultPathPlaceholder, resolvePromptArgs } from "./WriterTaskBuilder.ts";

export type WorkflowReviewRequest = {
  readonly sessionId: string;
  readonly artifactPath: string;
  readonly articleContent: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs?: number;
};

export type WorkflowReviewOutcome =
  | { readonly status: "completed" }
  | { readonly status: "revise"; readonly revisionBrief: string };

const completedToken = "Completed";
const defaultTimeoutMs = 10 * 60 * 1000;

const fallbackReviewOutputFilename = "fallback-review-last-message.txt";

const buildReviewContext = ({
  command,
  args,
  cwd,
  timeoutMs,
  artifactPath,
  details,
  exitCode,
}: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly artifactPath?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly exitCode?: number;
}) => ({
  command,
  args: [...args],
  ...(cwd !== undefined ? { cwd } : {}),
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  ...(exitCode !== undefined ? { exitCode } : {}),
  ...(details !== undefined
    ? {
        details: {
          ...(artifactPath !== undefined ? { artifactPath } : {}),
          ...details,
        },
      }
    : artifactPath !== undefined
      ? { details: { artifactPath } }
      : {}),
});

const buildReviewPrompt = ({
  sessionId,
  artifactPath,
  articleContent,
  userFeedback,
}: WorkflowReviewRequest & {
  readonly userFeedback: string;
}) =>
  [
    "You are the session-mind fallback review agent.",
    "You are reviewing an already-written article draft after automated validation passed.",
    `Session id: ${sessionId}`,
    `Article path: ${artifactPath}`,
    "The user will describe what still needs improvement.",
    `If the user's request means the article is already acceptable, return exactly ${completedToken}.`,
    "Otherwise return only a concise Chinese revision brief for the writer agent.",
    "The revision brief should be a short list of concrete editorial instructions, not an essay.",
    "Prioritize audience, framing, structure, narrative voice, and what to remove or rewrite.",
    "Do not rewrite the full article.",
    "Do not ask follow-up questions.",
    "Do not wrap the answer in markdown fences.",
    "",
    "User feedback:",
    userFeedback,
    "",
    "Current article:",
    "```md",
    articleContent,
    "```",
  ].join("\n");

const readUserFeedback = (artifactPath: string): Effect.Effect<string, SubprocessError> =>
  !process.stdin.isTTY || !process.stdout.isTTY
    ? Effect.fail(
        new SubprocessError({
          code: "SUBPROCESS_IO_FAILED",
          message: "Workflow review requires an interactive terminal",
          context: buildReviewContext({
            command: "terminal",
            args: [],
            artifactPath,
            details: {
              stdinIsTTY: Boolean(process.stdin.isTTY),
              stdoutIsTTY: Boolean(process.stdout.isTTY),
            },
          }),
        }),
      )
    : Effect.acquireUseRelease(
        Effect.sync(() =>
          createInterface({
            input: process.stdin,
            output: process.stdout,
          }),
        ),
        (terminal) =>
          Effect.tryPromise({
            try: () =>
              terminal.question(
                [
                  "",
                  `Review validated article: ${artifactPath}`,
                  `Type ${completedToken} if it is good enough, or describe what should be improved:`,
                  "> ",
                ].join("\n"),
              ),
            catch: (cause) =>
              new SubprocessError({
                code: "SUBPROCESS_IO_FAILED",
                message: "Failed to read workflow review input",
                context: buildReviewContext({
                  command: "terminal",
                  args: [],
                  artifactPath,
                  details: {
                    cause: String(cause),
                  },
                }),
              }),
          }),
        (terminal) =>
          Effect.sync(() => {
            terminal.close();
          }),
      );

export class WorkflowReviewer extends ServiceMap.Service<
  WorkflowReviewer,
  {
    review(request: WorkflowReviewRequest): Effect.Effect<WorkflowReviewOutcome, SubprocessError>;
  }
>()("session-mind/WorkflowReviewer") {
  static readonly layer = Layer.effect(WorkflowReviewer)(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const runFallbackAgent = ({
        command,
        args,
        cwd,
        prompt,
        timeoutMs,
      }: {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly prompt: string;
        readonly timeoutMs: number;
      }): Effect.Effect<
        { readonly stdout: string; readonly stderr: string; readonly finalMessage: string | null },
        SubprocessError
      > =>
        Effect.scoped(
          Effect.gen(function* () {
            const tempDirectory = yield* Effect.acquireRelease(
              Effect.tryPromise({
                try: () => mkdtemp(join(tmpdir(), "session-mind-review-")),
                catch: (cause) =>
                  new SubprocessError({
                    code: "SUBPROCESS_IO_FAILED",
                    message: "Failed to create temporary directory for fallback review output",
                    context: buildReviewContext({
                      command,
                      args,
                      cwd,
                      timeoutMs,
                      details: { cause: String(cause) },
                    }),
                  }),
              }),
              (directory) =>
                Effect.tryPromise({
                  try: () => rm(directory, { recursive: true, force: true }),
                  catch: () => undefined,
                }).pipe(Effect.orDie),
            );
            const resultPath = join(tempDirectory, fallbackReviewOutputFilename);
            const resolvedArgs = resolvePromptArgs(args, prompt, {
              [AgentResultPathPlaceholder]: resultPath,
            });
            const handle = yield* spawner
              .spawn(
                ChildProcess.make(command, [...resolvedArgs], {
                  cwd,
                  stdin: "inherit",
                  stdout: "inherit",
                  stderr: "inherit",
                  extendEnv: true,
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new SubprocessError({
                      code: "SUBPROCESS_SPAWN_FAILED",
                      message: "Failed to start fallback review agent",
                      context: buildReviewContext({
                        command,
                        args: resolvedArgs,
                        cwd,
                        timeoutMs,
                        details: { cause: String(cause) },
                      }),
                    }),
                ),
              );

            const stdoutRef = yield* Ref.make("");
            const stderrRef = yield* Ref.make("");

            const stdoutFiber = yield* handle.stdout.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Ref.update(stdoutRef, (stdout) => `${stdout}${chunk}`)),
              Effect.forkChild,
            );

            const stderrFiber = yield* handle.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
              Effect.forkChild,
            );

            const exitCode = yield* handle.exitCode.pipe(
              Effect.map(Number),
              Effect.timeout(Duration.millis(timeoutMs)),
              Effect.catchTag("TimeoutError", () =>
                handle.kill().pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(
                    Effect.fail(
                      new SubprocessError({
                        code: "SUBPROCESS_TIMED_OUT",
                        message: "Fallback review agent exceeded the configured timeout",
                        context: buildReviewContext({
                          command,
                          args: resolvedArgs,
                          cwd,
                          timeoutMs,
                        }),
                      }),
                    ),
                  ),
                ),
              ),
              Effect.mapError((cause) =>
                cause instanceof SubprocessError
                  ? cause
                  : new SubprocessError({
                      code: "SUBPROCESS_SPAWN_FAILED",
                      message: "Failed while waiting for fallback review agent completion",
                      context: buildReviewContext({
                        command,
                        args: resolvedArgs,
                        cwd,
                        timeoutMs,
                        details: { cause: String(cause) },
                      }),
                    }),
              ),
            );

            yield* Fiber.join(stdoutFiber).pipe(
              Effect.mapError(
                (cause) =>
                  new SubprocessError({
                    code: "SUBPROCESS_IO_FAILED",
                    message: "Failed to capture fallback review agent stdout",
                    context: buildReviewContext({
                      command,
                      args: resolvedArgs,
                      cwd,
                      timeoutMs,
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
                    message: "Failed to capture fallback review agent stderr",
                    context: buildReviewContext({
                      command,
                      args: resolvedArgs,
                      cwd,
                      timeoutMs,
                      details: { cause: String(cause) },
                    }),
                  }),
              ),
            );

            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            const finalMessage = yield* Effect.tryPromise({
              try: async () => await readFile(resultPath, "utf8"),
              catch: (cause) =>
                new SubprocessError({
                  code: "SUBPROCESS_IO_FAILED",
                  message: "Failed to read fallback review final message",
                  context: buildReviewContext({
                    command,
                    args: resolvedArgs,
                    cwd,
                    timeoutMs,
                    details: { cause: String(cause), resultPath },
                  }),
                }),
            }).pipe(Effect.catch(() => Effect.succeed(null)));

            if (exitCode !== 0) {
              return yield* new SubprocessError({
                code: "SUBPROCESS_EXITED_NON_ZERO",
                message: "Fallback review agent exited with a non-zero status",
                context: buildReviewContext({
                  command,
                  args: resolvedArgs,
                  cwd,
                  timeoutMs,
                  exitCode,
                  details: { stdout, stderr },
                }),
              });
            }

            return { stdout, stderr, finalMessage } as const;
          }),
        );

      const review = Effect.fn("WorkflowReviewer.review")(function* (
        request: WorkflowReviewRequest,
      ) {
        const userFeedback = (yield* readUserFeedback(request.artifactPath)).trim();
        if (userFeedback === "" || userFeedback === completedToken) {
          return { status: "completed" } as const;
        }

        const response = yield* runFallbackAgent({
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
          prompt: buildReviewPrompt({
            ...request,
            userFeedback,
          }),
        });

        const normalized = (response.finalMessage ?? response.stdout).trim();
        if (normalized === completedToken) {
          return { status: "completed" } as const;
        }

        if (normalized === "") {
          return yield* new SubprocessError({
            code: "SUBPROCESS_PROTOCOL_VIOLATION",
            message: "Fallback review agent completed without producing a revision brief",
            context: buildReviewContext({
              command: request.command,
              args: request.args,
              cwd: request.cwd,
              timeoutMs: request.timeoutMs ?? defaultTimeoutMs,
              artifactPath: request.artifactPath,
              details: {
                stdout: response.stdout,
                stderr: response.stderr,
              },
            }),
          });
        }

        return {
          status: "revise",
          revisionBrief: normalized,
        } as const;
      });

      return WorkflowReviewer.of({ review });
    }),
  ).pipe(Layer.provide(NodeServices.layer));
}
