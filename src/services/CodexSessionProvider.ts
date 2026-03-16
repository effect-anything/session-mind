import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { Effect, Layer, Option, ServiceMap } from "effect";
import {
  makeSessionKey,
  type ExtractedConversation,
  type SessionInfo,
  type SessionSource,
} from "../domain/Session.ts";
import { SessionProviderError } from "../errors/AppError.ts";

type CodexIndexEntry = {
  readonly id: string;
  readonly thread_name?: string;
  readonly updated_at?: string;
};

type CodexSessionSummary = {
  readonly nativeId: string;
  readonly title: string;
  readonly cwd?: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
};

type CodexEvent =
  | {
      readonly timestamp?: string;
      readonly type: "session_meta";
      readonly payload?: {
        readonly id?: string;
        readonly timestamp?: string;
        readonly cwd?: string;
      };
    }
  | {
      readonly timestamp?: string;
      readonly type: "response_item";
      readonly payload?:
        | {
            readonly type: "message";
            readonly role?: string;
            readonly content?: ReadonlyArray<
              | { readonly type?: "input_text"; readonly text?: string }
              | { readonly type?: "output_text"; readonly text?: string }
            >;
          }
        | { readonly type?: "reasoning" | "function_call" | "function_call_output" };
    }
  | {
      readonly timestamp?: string;
      readonly type?: string;
    };

type CodexMessagePayload = Extract<
  NonNullable<Extract<CodexEvent, { readonly type: "response_item" }>["payload"]>,
  { readonly type: "message" }
>;
type CodexMessagePart = NonNullable<CodexMessagePayload["content"]>[number];
type CodexTurn = ExtractedConversation["turns"][number];

const source: SessionSource = "codex";
const getCodexRoot = (): string => join(process.env["HOME"] ?? "", ".codex");
const getCodexSessionsRoot = (): string => join(getCodexRoot(), "sessions");
const getCodexIndexPath = (): string => join(getCodexRoot(), "session_index.jsonl");

const isCodexSessionMetaEvent = (
  event: CodexEvent,
): event is Extract<CodexEvent, { readonly type: "session_meta" }> =>
  event.type === "session_meta" && "payload" in event;

const isCodexResponseItemEvent = (
  event: CodexEvent,
): event is Extract<CodexEvent, { readonly type: "response_item" }> =>
  event.type === "response_item" && "payload" in event;

const isCodexMessagePayload = (
  payload: Extract<CodexEvent, { readonly type: "response_item" }>["payload"],
): payload is CodexMessagePayload => payload?.type === "message";

const isCodexInputTextPart = (
  part: CodexMessagePart,
): part is Extract<CodexMessagePart, { readonly type?: "input_text" }> =>
  part.type === "input_text";

const isCodexOutputTextPart = (
  part: CodexMessagePart,
): part is Extract<CodexMessagePart, { readonly type?: "output_text" }> =>
  part.type === "output_text";

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

const codexSessionIdLength = 36;

const normalizeTitle = (value: string, maxLength = 80): string => {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1)}...`;
};

const isSkippableTitleCandidate = (value: string): boolean =>
  value.startsWith("# AGENTS.md instructions") ||
  value.startsWith("<environment_context>") ||
  value.startsWith("<permissions instructions>") ||
  value.startsWith("<app-context>");

const getCodexNativeIdFromFilePath = (filePath: string): string =>
  basename(filePath, ".jsonl").slice(-codexSessionIdLength);

const readCodexIndexEntries = () =>
  Effect.sync(getCodexIndexPath).pipe(
    Effect.flatMap((codexIndexPath) =>
      Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(codexIndexPath, "utf8");
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
              return "";
            }

            throw cause;
          }
        },
        catch: (cause) =>
          toProviderError({
            message: `Failed to read Codex session index: ${String(cause)}`,
            path: codexIndexPath,
          }),
      }).pipe(
        Effect.map((raw) =>
          raw
            .split(/\r?\n/u)
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as CodexIndexEntry),
        ),
      ),
    ),
  );

const readCodexDirectories = (directory: string, label: string) =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(directory, entry.name));
    },
    catch: (cause) =>
      toProviderError({
        message: `Failed to read Codex ${label}: ${String(cause)}`,
        path: directory,
      }),
  });

const readCodexSessionFilesInDirectory = (directory: string) =>
  Effect.tryPromise({
    try: async () => {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(directory, entry.name));
    },
    catch: (cause) =>
      toProviderError({
        message: `Failed to read Codex day directory: ${String(cause)}`,
        path: directory,
      }),
  });

const readCodexSessionFiles = () =>
  Effect.gen(function* () {
    const codexSessionsRoot = getCodexSessionsRoot();
    const years = yield* readCodexDirectories(codexSessionsRoot, "sessions root");
    const files: Array<string> = [];

    for (const yearDirectory of years) {
      const months = yield* readCodexDirectories(yearDirectory, "year directory");

      for (const monthDirectory of months) {
        const days = yield* readCodexDirectories(monthDirectory, "month directory");

        for (const dayDirectory of days) {
          files.push(...(yield* readCodexSessionFilesInDirectory(dayDirectory)));
        }
      }
    }

    return files;
  });

const findCodexSessionFile = (
  nativeId: string,
): Effect.Effect<string | undefined, SessionProviderError> =>
  Effect.gen(function* () {
    const codexSessionsRoot = getCodexSessionsRoot();
    const years = yield* readCodexDirectories(codexSessionsRoot, "sessions root");

    for (const yearDirectory of years) {
      const months = yield* readCodexDirectories(yearDirectory, "year directory");

      for (const monthDirectory of months) {
        const days = yield* readCodexDirectories(monthDirectory, "month directory");

        for (const dayDirectory of days) {
          const files = (yield* readCodexSessionFilesInDirectory(dayDirectory)).filter((filePath) =>
            filePath.endsWith(`${nativeId}.jsonl`),
          );

          if (files[0] !== undefined) {
            return files[0];
          }
        }
      }
    }

    return undefined;
  });

const readCodexEvents = (filePath: string, nativeId: string) =>
  Effect.tryPromise({
    try: async () =>
      (await readFile(filePath, "utf8"))
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CodexEvent),
    catch: (cause) =>
      toProviderError({
        message: `Failed to read Codex session file: ${String(cause)}`,
        sessionId: nativeId,
        path: filePath,
      }),
  });

const readCodexSessionSummary = (
  filePath: string,
  entry?: CodexIndexEntry,
): Effect.Effect<CodexSessionSummary, SessionProviderError> =>
  Effect.gen(function* () {
    const fallbackNativeId = entry?.id ?? getCodexNativeIdFromFilePath(filePath);
    const fileStat = yield* Effect.tryPromise({
      try: () => stat(filePath),
      catch: (cause) =>
        toProviderError({
          message: `Failed to stat Codex session file: ${String(cause)}`,
          sessionId: fallbackNativeId,
          path: filePath,
        }),
    });
    const events = yield* readCodexEvents(filePath, fallbackNativeId);
    const sessionMeta = events.find(isCodexSessionMetaEvent);

    let timeCreated = parseIsoTime(
      sessionMeta?.payload?.timestamp ?? events[0]?.timestamp,
      fileStat.mtimeMs,
    );
    let timeUpdated = parseIsoTime(entry?.updated_at, fileStat.mtimeMs);
    let title = entry?.thread_name?.trim();
    let fallbackTitle: string | undefined;

    for (const event of events) {
      const eventTimestamp = parseIsoTime(event.timestamp, fileStat.mtimeMs);
      timeCreated = Math.min(timeCreated, eventTimestamp);
      timeUpdated = Math.max(timeUpdated, eventTimestamp);

      if (!isCodexResponseItemEvent(event)) {
        continue;
      }

      const payload = event.payload;
      if (!isCodexMessagePayload(payload) || payload.role !== "user") {
        continue;
      }

      const content = (payload.content ?? [])
        .flatMap(
          (part): Array<string> =>
            isCodexInputTextPart(part) && part.text !== undefined ? [part.text.trim()] : [],
        )
        .filter((segment) => segment.length > 0)
        .join("\n\n")
        .trim();

      if ((title === undefined || title.length === 0) && content.length > 0) {
        const normalizedTitle = normalizeTitle(content);
        if (fallbackTitle === undefined) {
          fallbackTitle = normalizedTitle;
        }
        if (!isSkippableTitleCandidate(normalizedTitle)) {
          title = normalizedTitle;
        }
      }
    }

    return {
      nativeId: sessionMeta?.payload?.id ?? fallbackNativeId,
      title: title && title.length > 0 ? title : (fallbackTitle ?? fallbackNativeId),
      ...(sessionMeta?.payload?.cwd !== undefined ? { cwd: sessionMeta.payload.cwd } : {}),
      timeCreated,
      timeUpdated,
    };
  });

const toSessionInfoFromSummary = (summary: CodexSessionSummary): SessionInfo => ({
  id: makeSessionKey(source, summary.nativeId),
  source,
  nativeId: summary.nativeId,
  title: summary.title,
  directory: summary.cwd ?? "",
  timeCreated: summary.timeCreated,
  timeUpdated: summary.timeUpdated,
  projectId: summary.cwd ?? "",
});

const toSessionInfo = (
  entry: CodexIndexEntry,
  {
    cwd,
    timeCreated,
    timeUpdated,
  }: {
    readonly cwd?: string;
    readonly timeCreated?: number;
    readonly timeUpdated?: number;
  } = {},
): SessionInfo => ({
  id: makeSessionKey(source, entry.id),
  source,
  nativeId: entry.id,
  title: entry.thread_name?.trim() || entry.id,
  directory: cwd ?? "",
  timeCreated: timeCreated ?? parseIsoTime(entry.updated_at, Date.now()),
  timeUpdated: timeUpdated ?? parseIsoTime(entry.updated_at, Date.now()),
  projectId: cwd ?? "",
});

const findCodexIndexEntry = (nativeId: string) =>
  readCodexIndexEntries().pipe(
    Effect.map((entries) => entries.find((entry) => entry.id === nativeId)),
  );

export class CodexSessionProvider extends ServiceMap.Service<
  CodexSessionProvider,
  {
    listRecent(limit: number): Effect.Effect<ReadonlyArray<SessionInfo>, SessionProviderError>;
    getByNativeId(
      nativeId: string,
    ): Effect.Effect<Option.Option<SessionInfo>, SessionProviderError>;
    extract(nativeId: string): Effect.Effect<ExtractedConversation, SessionProviderError>;
  }
>()("session-mind/CodexSessionProvider") {
  static readonly layer = Layer.succeed(
    CodexSessionProvider,
    CodexSessionProvider.of({
      listRecent: (limit) =>
        Effect.gen(function* () {
          const entries = yield* readCodexIndexEntries();
          const entryById = new Map(entries.map((entry) => [entry.id, entry] as const));
          const filePaths = yield* readCodexSessionFiles();
          const sessions = yield* Effect.forEach(filePaths, (filePath) =>
            Effect.gen(function* () {
              const nativeId = getCodexNativeIdFromFilePath(filePath);
              const summary = yield* readCodexSessionSummary(filePath, entryById.get(nativeId));
              entryById.delete(summary.nativeId);
              return toSessionInfoFromSummary(summary);
            }),
          );

          const indexedOnlySessions = Array.from(entryById.values()).map((entry) =>
            toSessionInfo(entry),
          );

          return [...sessions, ...indexedOnlySessions]
            .sort((left, right) => right.timeUpdated - left.timeUpdated)
            .slice(0, limit);
        }),
      getByNativeId: (nativeId) =>
        Effect.gen(function* () {
          const entry = yield* findCodexIndexEntry(nativeId);
          const filePath = yield* findCodexSessionFile(nativeId);
          if (filePath !== undefined) {
            const summary = yield* readCodexSessionSummary(filePath, entry);
            return Option.some(toSessionInfoFromSummary(summary));
          }

          return entry === undefined ? Option.none() : Option.some(toSessionInfo(entry));
        }),
      extract: (nativeId) =>
        Effect.gen(function* () {
          const entry = yield* findCodexIndexEntry(nativeId);
          const filePath = yield* findCodexSessionFile(nativeId);
          if (filePath === undefined) {
            return yield* toProviderError({
              message: `Could not locate the Codex rollout file for ${nativeId}`,
              sessionId: nativeId,
            });
          }

          const summary = yield* readCodexSessionSummary(filePath, entry);
          const events = yield* readCodexEvents(filePath, nativeId);

          let totalMessages = 0;
          let totalParts = 0;
          let droppedToolParts = 0;
          let droppedReasoningParts = 0;
          let droppedStepParts = 0;
          let droppedEmptyTextParts = 0;

          const turns: Array<CodexTurn> = [];

          for (const event of events) {
            if (!isCodexResponseItemEvent(event)) {
              if (event.type === "event_msg") {
                droppedStepParts += 1;
              }
              continue;
            }

            const payload = event.payload;

            if (payload?.type === "reasoning") {
              droppedReasoningParts += 1;
              continue;
            }

            if (payload?.type === "function_call" || payload?.type === "function_call_output") {
              droppedToolParts += 1;
              continue;
            }

            if (!isCodexMessagePayload(payload)) {
              continue;
            }

            if (payload.role !== "user" && payload.role !== "assistant") {
              continue;
            }

            totalMessages += 1;
            const textSegments = (payload.content ?? []).flatMap((part): Array<string> => {
              if (payload.role === "user" && isCodexInputTextPart(part)) {
                return [part.text?.trim() ?? ""];
              }
              if (payload.role === "assistant" && isCodexOutputTextPart(part)) {
                return [part.text?.trim() ?? ""];
              }
              return [];
            });

            totalParts += payload.content?.length ?? 0;
            const nonEmptySegments = textSegments.filter((segment: string) => segment.length > 0);
            droppedEmptyTextParts += textSegments.length - nonEmptySegments.length;
            const content = nonEmptySegments.join("\n\n").trim();
            if (content.length === 0) {
              continue;
            }

            turns.push({
              role: payload.role,
              content,
              timestamp: parseIsoTime(event.timestamp, Date.now()),
              sessionId: makeSessionKey(source, nativeId),
              source,
              messageId: `${nativeId}:${turns.length + 1}`,
            });
          }

          return {
            session: toSessionInfoFromSummary(summary),
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
