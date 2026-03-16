import { readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Data, Effect, Exit, Schema } from "effect";
import * as Console from "effect/Console";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import {
  SessionMindEnvironmentVariables,
  SessionMindOutputPaths,
} from "../domain/SubprocessProtocol";
import { SessionMindWorkflow } from "../services/SessionMindWorkflow";

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

const writeAgentPrompt = [
  "You are the session-mind writing subprocess.",
  "Do not ask follow-up questions and do not wait for interactive input.",
  `Read the prompt bundle from ${SessionMindEnvironmentVariables.promptBundle}.`,
  "If that environment variable contains a filesystem path, read the JSON file at that path.",
  "If it contains JSON directly, parse the JSON payload from the variable value.",
  `Use ${SessionMindEnvironmentVariables.outputDir} as the workflow output root.`,
  `Write the final markdown article to ${SessionMindEnvironmentVariables.outputDir}/articles/${SessionMindEnvironmentVariables.sessionId}.md.`,
  "Only write the final article markdown to that file.",
  "Exit with code 0 after the file is written successfully.",
  "If the article cannot be produced, write diagnostics to stderr and exit with code 3.",
].join("\n");

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

const resolveCliAgentPresets = Effect.fn("writeCommand.resolveCliAgentPresets")(
  function* (cwd: string) {
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
  },
);

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
          args: ["--dangerously-allow-all", ...preset.extraArgs, writeAgentPrompt],
        } as const;
      case "claude":
        return {
          command: "claude",
          args: ["--dangerously-skip-permissions", ...preset.extraArgs, writeAgentPrompt],
        } as const;
      case "codex":
        return {
          command: "codex",
          args: [
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            ...preset.extraArgs,
            writeAgentPrompt,
          ],
        } as const;
      case "opencode":
        return {
          command: "opencode",
          args: ["run", writeAgentPrompt, "--thinking", ...preset.extraArgs],
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
    sessionFile: Flag.file("session-file", { mustExist: true }).pipe(
      Flag.withDescription(
        "Path to an exported session JSON file or a file containing a single session id",
      ),
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
    agentPreset: Flag.string("agent-preset").pipe(
      Flag.withDefault("default"),
      Flag.withDescription(
        "Lalph CLI agent preset id used to choose the downstream writing agent",
      ),
    ),
  },
  ({ sessionFile, outputDir, timeout, agentPreset }) =>
    Effect.gen(function* () {
      const workflow = yield* SessionMindWorkflow;
      const cwd = process.cwd();
      const sessionId = yield* resolveSessionId(sessionFile);
      const preset = yield* resolvePreset(cwd, agentPreset);
      const invocation = yield* buildAgentInvocation(preset);
      const result = yield* workflow.run({
        sessionId,
        command: invocation.command,
        args: invocation.args,
        workdir: cwd,
        cwd,
        outputDir,
        timeoutMs: timeout * 1_000,
      });

      yield* Console.log(
        `Generated article for ${result.sessionId} at ${result.artifactPath} using preset ${preset.id}`,
      );
    }),
).pipe(
  Command.withDescription(
    "Run the session-mind workflow for one session file and spawn a downstream writing agent",
  ),
  Command.withExamples([
    {
      command: "session-article write --session-file ./session-123.json",
      description: "Resolve a session id from an exported session file and generate an article",
    },
    {
      command:
        "session-article write --session-file ./session-id.txt --agent-preset opencode --output-dir ./.output/session-mind --timeout 900",
      description: "Use a specific writing-agent preset and custom workflow output directory",
    },
  ]),
);
