import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Effect, Layer, Option, ServiceMap } from "effect";
import {
  makeSessionKey,
  type ExtractedConversation,
  type SessionInfo,
  type SessionSource,
} from "../domain/Session.ts";
import { SessionProviderError } from "../errors/AppError.ts";

type ClaudeIndexEntry = {
  readonly sessionId: string;
  readonly fullPath: string;
  readonly fileMtime?: number;
  readonly firstPrompt?: string;
  readonly summary?: string;
  readonly messageCount?: number;
  readonly created?: string;
  readonly modified?: string;
  readonly gitBranch?: string;
  readonly projectPath?: string;
  readonly isSidechain?: boolean;
};

type ClaudeJsonlEvent =
  | {
      readonly type: "user";
      readonly uuid?: string;
      readonly timestamp?: string;
      readonly isMeta?: boolean;
      readonly gitBranch?: string;
      readonly message?: {
        readonly role?: string;
        readonly content?: string;
      };
      readonly sessionId?: string;
      readonly cwd?: string;
    }
  | {
      readonly type: "assistant";
      readonly uuid?: string;
      readonly timestamp?: string;
      readonly isMeta?: boolean;
      readonly gitBranch?: string;
      readonly message?: {
        readonly role?: string;
        readonly content?: ReadonlyArray<
          | { readonly type?: "text"; readonly text?: string }
          | { readonly type?: "tool_use"; readonly id?: string }
        >;
      };
      readonly sessionId?: string;
      readonly cwd?: string;
    }
  | {
      readonly type?: string;
      readonly uuid?: string;
      readonly timestamp?: string;
      readonly isMeta?: boolean;
      readonly gitBranch?: string;
      readonly sessionId?: string;
      readonly cwd?: string;
    };

type ClaudeAssistantPart = NonNullable<
  NonNullable<Extract<ClaudeJsonlEvent, { readonly type: "assistant" }>["message"]>["content"]
>[number];
type ClaudeTurn = ExtractedConversation["turns"][number];

const source: SessionSource = "claude";
const getClaudeProjectsRoot = (): string => join(process.env["HOME"] ?? "", ".claude", "projects");

const isClaudeUserEvent = (
  event: ClaudeJsonlEvent,
): event is Extract<ClaudeJsonlEvent, { readonly type: "user" }> =>
  event.type === "user" && "message" in event;

const isClaudeAssistantEvent = (
  event: ClaudeJsonlEvent,
): event is Extract<ClaudeJsonlEvent, { readonly type: "assistant" }> =>
  event.type === "assistant" && "message" in event;

const isClaudeTextPart = (
  part: ClaudeAssistantPart,
): part is { readonly type?: "text"; readonly text?: string } => part.type === "text";

const isClaudeToolUsePart = (
  part: ClaudeAssistantPart,
): part is { readonly type?: "tool_use"; readonly id?: string } => part.type === "tool_use";

const toProviderError = ({
  message,
  sessionId,
  path,
}: {
  readonly message: string;
  readonly sessionId?: string;
  readonly path?: string;
}) =>
  new SessionProviderError({
    message,
    source,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(path !== undefined ? { path } : {}),
  });

const parseIsoTime = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? fallback : timestamp;
};

const normalizeTitle = (value: string, maxLength = 80): string => {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}...`;
};

const isSkippableTitleCandidate = (value: string): boolean =>
  value.startsWith("# AGENTS.md instructions") ||
  value.startsWith("<environment_context>") ||
  value.startsWith("<local-command-caveat>") ||
  value.startsWith("<command-name>") ||
  value.startsWith("<local-command-stdout>");

const readClaudeProjectIndexEntries = (projectDirectory: string) =>
  Effect.tryPromise({
    try: async () => {
      const indexPath = join(projectDirectory, "sessions-index.json");
      const raw = JSON.parse(await readFile(indexPath, "utf8")) as {
        readonly entries?: ReadonlyArray<ClaudeIndexEntry>;
      };
      return raw.entries ?? [];
    },
    catch: (cause) =>
      toProviderError({
        message: `Failed to read Claude session index: ${String(cause)}`,
        path: join(projectDirectory, "sessions-index.json"),
      }),
  });

const readClaudeJsonlFallbackEntry = (filePath: string) =>
  Effect.gen(function* () {
    const fileStat = yield* Effect.tryPromise({
      try: () => stat(filePath),
      catch: (cause) =>
        toProviderError({
          message: `Failed to stat Claude session file: ${String(cause)}`,
          path: filePath,
        }),
    });

    const lines = yield* Effect.tryPromise({
      try: async () =>
        (await readFile(filePath, "utf8"))
          .split(/\r?\n/u)
          .map((line) => line.trim())
          .filter((line) => line.length > 0),
      catch: (cause) =>
        toProviderError({
          message: `Failed to read Claude session file: ${String(cause)}`,
          path: filePath,
        }),
    });

    let sessionId = basename(filePath, ".jsonl");
    let firstPrompt: string | undefined;
    let projectPath: string | undefined;
    let gitBranch: string | undefined;
    let createdAt = fileStat.mtimeMs;
    let updatedAt = fileStat.mtimeMs;
    let sawTimestamp = false;

    for (const line of lines) {
      const event = yield* Effect.try({
        try: () => JSON.parse(line) as ClaudeJsonlEvent,
        catch: () =>
          toProviderError({
            message: "Failed to parse a Claude session event",
            sessionId,
            path: filePath,
          }),
      });

      if (event.sessionId !== undefined) {
        sessionId = event.sessionId;
      }

      if (projectPath === undefined && event.cwd !== undefined && event.cwd.length > 0) {
        projectPath = event.cwd;
      }

      if (gitBranch === undefined && event.gitBranch !== undefined) {
        gitBranch = event.gitBranch;
      }

      const timestamp = parseIsoTime(event.timestamp, fileStat.mtimeMs);
      if (event.timestamp !== undefined) {
        if (!sawTimestamp) {
          createdAt = timestamp;
          updatedAt = timestamp;
          sawTimestamp = true;
        } else {
          createdAt = Math.min(createdAt, timestamp);
          updatedAt = Math.max(updatedAt, timestamp);
        }
      }

      if (firstPrompt === undefined && isClaudeUserEvent(event) && event.isMeta !== true) {
        const content = event.message?.content?.trim();
        if (content !== undefined && content.length > 0) {
          const normalizedContent = normalizeTitle(content);
          if (!isSkippableTitleCandidate(normalizedContent)) {
            firstPrompt = normalizedContent;
          }
        }
      }
    }

    const entry: ClaudeIndexEntry = {
      sessionId,
      fullPath: filePath,
      fileMtime: fileStat.mtimeMs,
      ...(projectPath !== undefined ? { projectPath } : {}),
      ...(gitBranch !== undefined ? { gitBranch } : {}),
      created: new Date(createdAt).toISOString(),
      modified: new Date(updatedAt).toISOString(),
      ...(firstPrompt !== undefined ? { firstPrompt } : {}),
    };

    return entry;
  });

const readClaudeProjectEntries = (projectDirectory: string) =>
  Effect.gen(function* () {
    const entries = yield* Effect.tryPromise({
      try: () => readdir(projectDirectory, { withFileTypes: true }),
      catch: (cause) =>
        toProviderError({
          message: `Failed to read Claude project directory: ${String(cause)}`,
          path: projectDirectory,
        }),
    });

    if (entries.some((entry) => entry.isFile() && entry.name === "sessions-index.json")) {
      return yield* readClaudeProjectIndexEntries(projectDirectory);
    }

    const sessionFiles = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => join(projectDirectory, entry.name));

    return yield* Effect.forEach(sessionFiles, readClaudeJsonlFallbackEntry);
  });

const readAllClaudeEntries = () =>
  Effect.gen(function* () {
    const claudeProjectsRoot = getClaudeProjectsRoot();
    const projectDirectories = yield* Effect.tryPromise({
      try: async () => {
        const entries = await readdir(claudeProjectsRoot, { withFileTypes: true });
        return entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(claudeProjectsRoot, entry.name));
      },
      catch: (cause) =>
        toProviderError({
          message: `Failed to read Claude projects directory: ${String(cause)}`,
          path: claudeProjectsRoot,
        }),
    });

    const groups = yield* Effect.forEach(projectDirectories, readClaudeProjectEntries);

    return Array.from(
      new Map(groups.flat().map((entry) => [entry.sessionId, entry] as const)).values(),
    );
  });

const toSessionInfo = (entry: ClaudeIndexEntry): SessionInfo => ({
  id: makeSessionKey(source, entry.sessionId),
  source,
  nativeId: entry.sessionId,
  title: entry.summary?.trim() || entry.firstPrompt?.trim().slice(0, 80) || entry.sessionId,
  directory: entry.projectPath ?? dirname(entry.fullPath),
  timeCreated: parseIsoTime(entry.created, entry.fileMtime ?? Date.now()),
  timeUpdated: parseIsoTime(entry.modified, entry.fileMtime ?? Date.now()),
  projectId: entry.projectPath ?? dirname(entry.fullPath),
});

const findEntryByNativeId = (nativeId: string) =>
  readAllClaudeEntries().pipe(
    Effect.map((entries) => entries.find((entry) => entry.sessionId === nativeId)),
  );

export class ClaudeSessionProvider extends ServiceMap.Service<
  ClaudeSessionProvider,
  {
    listRecent(limit: number): Effect.Effect<ReadonlyArray<SessionInfo>, SessionProviderError>;
    getByNativeId(
      nativeId: string,
    ): Effect.Effect<Option.Option<SessionInfo>, SessionProviderError>;
    extract(nativeId: string): Effect.Effect<ExtractedConversation, SessionProviderError>;
  }
>()("session-mind/ClaudeSessionProvider") {
  static readonly layer = Layer.succeed(
    ClaudeSessionProvider,
    ClaudeSessionProvider.of({
      listRecent: (limit) =>
        readAllClaudeEntries().pipe(
          Effect.map((entries) =>
            entries
              .slice()
              .sort(
                (left, right) =>
                  parseIsoTime(right.modified, right.fileMtime ?? 0) -
                  parseIsoTime(left.modified, left.fileMtime ?? 0),
              )
              .slice(0, limit)
              .map(toSessionInfo),
          ),
        ),
      getByNativeId: (nativeId) =>
        findEntryByNativeId(nativeId).pipe(
          Effect.map((entry) =>
            entry === undefined ? Option.none() : Option.some(toSessionInfo(entry)),
          ),
        ),
      extract: (nativeId) =>
        Effect.gen(function* () {
          const entry = yield* findEntryByNativeId(nativeId);

          if (entry === undefined) {
            return yield* toProviderError({
              message: `Claude session ${nativeId} was not found`,
              sessionId: nativeId,
            });
          }

          const lines = yield* Effect.tryPromise({
            try: async () =>
              (await readFile(entry.fullPath, "utf8"))
                .split(/\r?\n/u)
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            catch: (cause) =>
              toProviderError({
                message: `Failed to read Claude session file: ${String(cause)}`,
                sessionId: nativeId,
                path: entry.fullPath,
              }),
          });

          let totalMessages = 0;
          let totalParts = 0;
          let droppedToolParts = 0;
          let droppedReasoningParts = 0;
          let droppedStepParts = 0;
          let droppedEmptyTextParts = 0;

          const turns: Array<ClaudeTurn> = [];

          for (const line of lines) {
            const event = yield* Effect.try({
              try: () => JSON.parse(line) as ClaudeJsonlEvent,
              catch: () =>
                toProviderError({
                  message: "Failed to parse a Claude session event",
                  sessionId: nativeId,
                  path: entry.fullPath,
                }),
            });

            if (isClaudeUserEvent(event)) {
              totalMessages += 1;
              totalParts += 1;
              const content = event.message?.content?.trim() ?? "";
              if (content.length === 0) {
                droppedEmptyTextParts += 1;
                continue;
              }

              turns.push({
                role: "user",
                content,
                timestamp: parseIsoTime(event.timestamp, entry.fileMtime ?? Date.now()),
                sessionId: makeSessionKey(source, nativeId),
                source,
                messageId: event.uuid ?? `${nativeId}:${turns.length + 1}`,
              });
              continue;
            }

            if (isClaudeAssistantEvent(event)) {
              totalMessages += 1;
              const parts = event.message?.content ?? [];
              totalParts += parts.length;
              const textSegments: Array<string> = [];

              for (const part of parts) {
                if (isClaudeTextPart(part)) {
                  const text = part.text?.trim() ?? "";
                  if (text.length === 0) {
                    droppedEmptyTextParts += 1;
                  } else {
                    textSegments.push(text);
                  }
                } else if (isClaudeToolUsePart(part)) {
                  droppedToolParts += 1;
                }
              }

              const content = textSegments.join("\n\n").trim();
              if (content.length === 0) {
                continue;
              }

              turns.push({
                role: "assistant",
                content,
                timestamp: parseIsoTime(event.timestamp, entry.fileMtime ?? Date.now()),
                sessionId: makeSessionKey(source, nativeId),
                source,
                messageId: event.uuid ?? `${nativeId}:${turns.length + 1}`,
              });
              continue;
            }

            if (event.type === "progress" || event.type === "file-history-snapshot") {
              droppedStepParts += 1;
            } else {
              droppedReasoningParts += 1;
            }
          }

          return {
            session: toSessionInfo(entry),
            turns,
            extractedAt: Date.now(),
            stats: {
              totalMessages,
              totalParts,
              keptTurns: turns.length,
              droppedToolParts,
              droppedReasoningParts,
              droppedStepParts,
              droppedEmptyTextParts,
            },
          } satisfies ExtractedConversation;
        }),
    }),
  );
}
