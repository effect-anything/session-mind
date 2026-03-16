import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Data, Effect, Exit, Option, Schema } from "effect";
import * as Console from "effect/Console";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { parseSessionIdentifier } from "../domain/Session.ts";
import { SessionMindOutputPaths } from "../domain/SubprocessProtocol.ts";
import { SessionMindWorkflow } from "../services/SessionMindWorkflow.ts";
import {
  SessionProviderRegistry,
  type SessionSourceFilter,
} from "../services/SessionProviderRegistry.ts";
import { WorkflowStateManager } from "../services/WorkflowStateManager.ts";
import {
  AgentResultPathPlaceholder,
  WriterPromptArgumentPlaceholder,
} from "../services/WriterTaskBuilder.ts";

class WriteCommandError extends Data.TaggedError("WriteCommandError")<{
  readonly message: string;
}> {}

const CliAgentIdSchema = Schema.Union([
  Schema.Literal("amp"),
  Schema.Literal("claude"),
  Schema.Literal("clanka"),
  Schema.Literal("codex"),
  Schema.Literal("opencode"),
]);
const CliAgentPresetSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  cliAgent: CliAgentIdSchema,
  commandPrefix: Schema.Array(Schema.String),
  extraArgs: Schema.Array(Schema.String),
});

type CliAgentPreset = Schema.Schema.Type<typeof CliAgentPresetSchema>;

const SessionFileMetadataSchema = Schema.Union([
  Schema.Struct({ sessionId: Schema.NonEmptyString }),
  Schema.Struct({ id: Schema.NonEmptyString }),
  Schema.Struct({
    session: Schema.Struct({
      id: Schema.NonEmptyString,
    }),
  }),
  Schema.Array(Schema.NonEmptyString),
]);

type SessionFileMetadata = Schema.Schema.Type<typeof SessionFileMetadataSchema>;

const decodePresets = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(CliAgentPresetSchema)),
);
const decodeSessionFileMetadata = Schema.decodeUnknownEffect(
  Schema.fromJsonString(SessionFileMetadataSchema),
);

const defaultPreset: CliAgentPreset = {
  id: "default",
  cliAgent: "codex",
  commandPrefix: [],
  extraArgs: [],
};

const presetsConfigPath = (cwd: string) =>
  join(cwd, ".lalph", "config", "settings.cliAgentPresets");

const defaultOutputDir = join(process.cwd(), SessionMindOutputPaths.workflowRoot);
const defaultTimeoutSeconds = 30 * 60;
const workflowStateFilePathFor = (outputDir: string) =>
  join(outputDir, SessionMindOutputPaths.stateFile);
const sessionIdArgument = Argument.string("session-id").pipe(
  Argument.withDescription("Session id to run through the workflow. Use source:id to be explicit."),
  Argument.optional,
);

type ResolvedSessionInput = {
  readonly sessionId: string;
  readonly message?: string;
};

const makeResolvedSessionInput = (sessionId: string, message?: string): ResolvedSessionInput => ({
  sessionId,
  ...(message !== undefined ? { message } : {}),
});

const unwrapSingleSessionId = (
  metadata: SessionFileMetadata,
  sessionFile: string,
): Effect.Effect<string, WriteCommandError> => {
  if (Array.isArray(metadata)) {
    if (metadata.length === 1) {
      return Effect.succeed(metadata[0]!);
    }

    return Effect.fail(
      new WriteCommandError({
        message: `Session file ${sessionFile} resolved to ${metadata.length} session ids. The current write command supports one session per invocation.`,
      }),
    );
  }

  if ("sessionId" in metadata) {
    return Effect.succeed(metadata.sessionId);
  }

  if ("session" in metadata) {
    return Effect.succeed(metadata.session.id);
  }

  if ("id" in metadata) {
    return Effect.succeed(metadata.id);
  }

  return Effect.fail(
    new WriteCommandError({
      message: `Could not resolve a session id from ${sessionFile}.`,
    }),
  );
};

const resolveSessionId = Effect.fn("writeCommand.resolveSessionId")(function* (
  sessionFile: string,
) {
  const contents = yield* Effect.tryPromise({
    try: () => readFile(sessionFile, "utf8"),
    catch: (cause) =>
      new WriteCommandError({
        message: `Failed to read session file ${sessionFile}: ${String(cause)}`,
      }),
  });

  const decoded = yield* Effect.exit(decodeSessionFileMetadata(contents));
  if (Exit.isSuccess(decoded)) {
    return yield* unwrapSingleSessionId(decoded.value, sessionFile);
  }

  const nonEmptyLines = contents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (nonEmptyLines.length === 1) {
    return nonEmptyLines[0]!;
  }

  const stem = basename(sessionFile, extname(sessionFile)).trim();
  if (stem.length > 0) {
    return stem;
  }

  return yield* new WriteCommandError({
    message: `Could not resolve a session id from ${sessionFile}. Expected JSON with session metadata, a single plain-text id, or a filename stem.`,
  });
});

const resolveRequestedSessionId = Effect.fn("writeCommand.resolveRequestedSessionId")(function* ({
  sessionId,
  sessionFile,
  latest,
  resumeLatest,
  source,
  outputDir,
}: {
  readonly sessionId: Option.Option<string>;
  readonly sessionFile: Option.Option<string>;
  readonly latest: boolean;
  readonly resumeLatest: boolean;
  readonly source: SessionSourceFilter;
  readonly outputDir: string;
}) {
  const providedInputCount =
    Number(Option.isSome(sessionId)) +
    Number(Option.isSome(sessionFile)) +
    Number(latest) +
    Number(resumeLatest);

  if (providedInputCount > 1) {
    return yield* new WriteCommandError({
      message:
        "Pass only one session selector: a positional session id, --session-file, --latest, or --resume-latest.",
    });
  }

  const providers = yield* SessionProviderRegistry;
  const stateManager = yield* WorkflowStateManager;
  const effectiveSource =
    Option.isSome(sessionId) && sessionId.value.includes(":")
      ? parseSessionIdentifier(sessionId.value).source
      : source;

  if (Option.isSome(sessionId)) {
    return yield* providers.resolveSession(sessionId.value, effectiveSource).pipe(
      Effect.map((resolved) => makeResolvedSessionInput(resolved.id)),
      Effect.mapError(
        (cause) =>
          new WriteCommandError({
            message: cause.message,
          }),
      ),
    );
  }

  if (Option.isSome(sessionFile)) {
    const resolvedFromFile = yield* resolveSessionId(sessionFile.value);
    return yield* providers.resolveSession(resolvedFromFile, source).pipe(
      Effect.map((resolved) => makeResolvedSessionInput(resolved.id)),
      Effect.mapError(
        (cause) =>
          new WriteCommandError({
            message: cause.message,
          }),
      ),
    );
  }

  const resolveLatestSession = (
    selection: "latest" | "resume-latest",
  ): Effect.Effect<ResolvedSessionInput, WriteCommandError> =>
    Effect.gen(function* () {
      const sessions = yield* providers.listRecent(1, effectiveSource).pipe(
        Effect.mapError(
          (cause) =>
            new WriteCommandError({
              message: `Failed to load recent sessions: ${String(cause)}`,
            }),
        ),
      );
      const currentSession = sessions[0];

      if (currentSession === undefined) {
        return yield* new WriteCommandError({
          message:
            "No sessions were found. Pass a positional session id or --session-file after creating at least one session.",
        });
      }

      return makeResolvedSessionInput(
        currentSession.id,
        selection === "latest"
          ? `Auto-selected most recent ${currentSession.source} session ${currentSession.id} (${currentSession.title})`
          : `No reusable draft workflow was found. Falling back to the most recent ${currentSession.source} session ${currentSession.id} (${currentSession.title})`,
      );
    });

  if (resumeLatest || providedInputCount === 0) {
    const workflowState = yield* stateManager.readState(workflowStateFilePathFor(outputDir)).pipe(
      Effect.mapError(
        (cause) =>
          new WriteCommandError({
            message: `Failed to read workflow state from ${workflowStateFilePathFor(outputDir)}: ${String(cause)}`,
          }),
      ),
    );
    const latestDraftSession = Object.values(workflowState.sessions)
      .filter(
        (state) =>
          state.articleStatus === "draft" &&
          (effectiveSource === "all" ||
            parseSessionIdentifier(state.sessionId).source === effectiveSource),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];

    if (latestDraftSession !== undefined) {
      return makeResolvedSessionInput(
        latestDraftSession.sessionId,
        `Auto-selected draft workflow session ${latestDraftSession.sessionId} from stage ${latestDraftSession.stage}`,
      );
    }

    return yield* resolveLatestSession("resume-latest");
  }

  if (latest) {
    return yield* resolveLatestSession("latest");
  }

  return yield* resolveLatestSession("resume-latest");
});

const resolveCliAgentPresets = Effect.fn("writeCommand.resolveCliAgentPresets")(function* (
  cwd: string,
) {
  const filePath = presetsConfigPath(cwd);
  const rawPresets = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(filePath, "utf8");
      } catch (cause) {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        ) {
          return null;
        }

        throw cause;
      }
    },
    catch: (cause) =>
      new WriteCommandError({
        message: `Failed to read preset configuration ${filePath}: ${String(cause)}`,
      }),
  });

  if (rawPresets === null) {
    return [defaultPreset] as const;
  }

  return yield* decodePresets(rawPresets).pipe(
    Effect.mapError(
      (cause) =>
        new WriteCommandError({
          message: `Failed to decode preset configuration ${filePath}: ${String(cause)}`,
        }),
    ),
  );
});

const resolvePreset = Effect.fn("writeCommand.resolvePreset")(function* (
  cwd: string,
  presetId: string,
) {
  const presets = yield* resolveCliAgentPresets(cwd);
  const preset = presets.find((item) => item.id === presetId);

  if (preset !== undefined) {
    return preset;
  }

  return yield* new WriteCommandError({
    message: `Unknown agent preset "${presetId}". Available presets: ${presets.map((item) => item.id).join(", ")}`,
  });
});

const applyCommandPrefix = (
  preset: CliAgentPreset,
  invocation: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  },
) => {
  if (preset.commandPrefix.length === 0) {
    return invocation;
  }

  return {
    command: preset.commandPrefix[0]!,
    args: [...preset.commandPrefix.slice(1), invocation.command, ...invocation.args],
  };
};

const buildAgentInvocation = (
  preset: CliAgentPreset,
  mode: "interactive" | "non-interactive" = "interactive",
): Effect.Effect<
  {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
  },
  WriteCommandError
> => {
  const baseInvocation = (() => {
    switch (preset.cliAgent) {
      case "amp":
        return {
          command: "amp",
          args: ["--dangerously-allow-all", ...preset.extraArgs, WriterPromptArgumentPlaceholder],
        } as const;
      case "claude":
        return {
          command: "claude",
          args: [
            "--dangerously-skip-permissions",
            ...preset.extraArgs,
            WriterPromptArgumentPlaceholder,
          ],
        } as const;
      case "codex":
        return {
          command: "codex",
          args: [
            ...(mode === "non-interactive" ? ["exec"] : []),
            "--dangerously-bypass-approvals-and-sandbox",
            ...preset.extraArgs,
            ...(mode === "non-interactive"
              ? ["--output-last-message", AgentResultPathPlaceholder]
              : []),
            WriterPromptArgumentPlaceholder,
          ],
        } as const;
      case "opencode":
        return {
          command: "opencode",
          args: ["run", WriterPromptArgumentPlaceholder, "--thinking", ...preset.extraArgs],
        } as const;
      case "clanka":
        return null;
    }
  })();

  if (baseInvocation === null) {
    return Effect.fail(
      new WriteCommandError({
        message: `Agent preset "${preset.id}" uses clanka, which is not supported by the session-mind write command.`,
      }),
    );
  }

  return Effect.succeed(applyCommandPrefix(preset, baseInvocation));
};

export const writeCommand = Command.make(
  "write",
  {
    sessionId: sessionIdArgument,
    sessionFile: Flag.file("session-file", { mustExist: true }).pipe(
      Flag.withDescription(
        "Optional legacy input: exported session JSON file or a file containing a single session id",
      ),
      Flag.optional,
    ),
    latest: Flag.boolean("latest").pipe(
      Flag.withDescription("Use the most recent session instead of passing a session id"),
    ),
    resumeLatest: Flag.boolean("resume-latest").pipe(
      Flag.withDescription(
        "Prefer the most recently updated draft workflow session, then fall back to the most recent session",
      ),
    ),
    source: Flag.string("source").pipe(
      Flag.withDefault("all"),
      Flag.withDescription("Session source: all, opencode, codex, or claude"),
    ),
    outputDir: Flag.directory("output-dir").pipe(
      Flag.withDefault(defaultOutputDir),
      Flag.withDescription(
        "Workflow output directory for state, prompt bundles, and generated articles",
      ),
    ),
    timeout: Flag.integer("timeout").pipe(
      Flag.withDefault(defaultTimeoutSeconds),
      Flag.withDescription("Subprocess timeout in seconds"),
    ),
    maxIterations: Flag.integer("max-iterations").pipe(
      Flag.withDefault(3),
      Flag.withDescription("Maximum writer iterations before the workflow fails"),
    ),
    agentPreset: Flag.string("agent-preset").pipe(
      Flag.withDefault("default"),
      Flag.withDescription("Lalph CLI agent preset id used to choose the downstream writing agent"),
    ),
  },
  ({
    sessionId,
    sessionFile,
    latest,
    resumeLatest,
    source,
    outputDir,
    timeout,
    maxIterations,
    agentPreset,
  }) =>
    Effect.gen(function* () {
      const workflow = yield* SessionMindWorkflow;
      const cwd = process.cwd();
      const resolvedSession = yield* resolveRequestedSessionId({
        sessionId,
        sessionFile,
        latest,
        resumeLatest,
        source: source as SessionSourceFilter,
        outputDir,
      });
      if (resolvedSession.message !== undefined) {
        yield* Console.log(resolvedSession.message);
      }
      const preset = yield* resolvePreset(cwd, agentPreset);
      const invocation = yield* buildAgentInvocation(preset, "interactive");
      const reviewInvocation = yield* buildAgentInvocation(preset, "non-interactive");
      const result = yield* workflow.run({
        sessionId: resolvedSession.sessionId,
        command: invocation.command,
        args: invocation.args,
        reviewCommand: reviewInvocation.command,
        reviewArgs: reviewInvocation.args,
        workdir: cwd,
        cwd,
        outputDir,
        timeoutMs: timeout * 1_000,
        stdioMode: "foreground",
        maxIterations,
      });

      yield* Console.log(
        `Generated draft article for ${result.sessionId} at ${result.artifactPath} using preset ${preset.id}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Run the full article-writing workflow for one session and spawn a downstream writing agent",
  ),
  Command.withExamples([
    {
      command: "session-mind write session-123",
      description: "Run the full workflow directly from an OpenCode session id",
    },
    {
      command: "session-mind write",
      description:
        "Continue the most recent draft workflow session, or fall back to the most recent session across all providers",
    },
    {
      command: "session-mind write --latest",
      description: "Start from the most recent session without copying its session id",
    },
    {
      command: "session-mind write --source claude --latest",
      description: "Start from the most recent Claude session",
    },
    {
      command:
        "session-mind write session-123 --agent-preset opencode --output-dir ./.output/session-mind --timeout 900 --max-iterations 4",
      description: "Use a specific writing-agent preset and custom workflow output directory",
    },
    {
      command: "session-mind write --session-file ./session-123.json",
      description: "Resolve a session id from a legacy exported session file",
    },
  ]),
);
