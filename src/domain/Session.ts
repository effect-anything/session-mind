import * as Schema from "effect/Schema";

export const SessionSourceSchema = Schema.Literals(["opencode", "codex", "claude"]);

export type SessionSource = Schema.Schema.Type<typeof SessionSourceSchema>;

export type SessionIdentifier = {
  readonly source: SessionSource;
  readonly nativeId: string;
  readonly key: string;
};

export const defaultSessionSource: SessionSource = "opencode";

export const makeSessionKey = (source: SessionSource, nativeId: string): string =>
  `${source}:${nativeId}`;

export const parseSessionIdentifier = (
  value: string,
  fallbackSource: SessionSource = defaultSessionSource,
): SessionIdentifier => {
  const trimmed = value.trim();
  const separatorIndex = trimmed.indexOf(":");

  if (separatorIndex > 0) {
    const sourceCandidate = trimmed.slice(0, separatorIndex);
    const nativeId = trimmed.slice(separatorIndex + 1);

    if (
      (sourceCandidate === "opencode" ||
        sourceCandidate === "codex" ||
        sourceCandidate === "claude") &&
      nativeId.length > 0
    ) {
      return {
        source: sourceCandidate,
        nativeId,
        key: makeSessionKey(sourceCandidate, nativeId),
      } satisfies SessionIdentifier;
    }
  }

  return {
    source: fallbackSource,
    nativeId: trimmed,
    key: makeSessionKey(fallbackSource, trimmed),
  } satisfies SessionIdentifier;
};

export const resolveSessionScopedFileName = (sessionId: string, extension: string): string => {
  const identifier = parseSessionIdentifier(sessionId);
  return `${identifier.nativeId}${extension}`;
};

export const resolveSessionScopedDirectory = (baseDirectory: string, sessionId: string): string => {
  const identifier = parseSessionIdentifier(sessionId);
  return `${baseDirectory}/${identifier.source}`;
};

export const SessionInfoSchema = Schema.Struct({
  id: Schema.String,
  source: Schema.optional(SessionSourceSchema),
  nativeId: Schema.optional(Schema.String),
  title: Schema.String,
  directory: Schema.String,
  timeCreated: Schema.Number,
  timeUpdated: Schema.Number,
  projectId: Schema.String,
});

export type SessionInfo = Schema.Schema.Type<typeof SessionInfoSchema>;

export const ConversationTurnSchema = Schema.Struct({
  role: Schema.Union([Schema.Literal("user"), Schema.Literal("assistant")]),
  content: Schema.String,
  timestamp: Schema.Number,
  sessionId: Schema.String,
  source: Schema.optional(SessionSourceSchema),
  messageId: Schema.String,
});

export type ConversationTurn = Schema.Schema.Type<typeof ConversationTurnSchema>;

export const ExtractedConversationSchema = Schema.Struct({
  session: SessionInfoSchema,
  turns: Schema.Array(ConversationTurnSchema),
  extractedAt: Schema.Number,
  stats: Schema.Struct({
    totalMessages: Schema.Number,
    totalParts: Schema.Number,
    keptTurns: Schema.Number,
    droppedToolParts: Schema.Number,
    droppedReasoningParts: Schema.Number,
    droppedStepParts: Schema.Number,
    droppedEmptyTextParts: Schema.Number,
  }),
});

export type ExtractedConversation = Schema.Schema.Type<typeof ExtractedConversationSchema>;

export const PromptBundleSchema = Schema.Struct({
  topicHint: Schema.String,
  writingBrief: Schema.String,
  sourceSessionIds: Schema.Array(Schema.String),
  generatedAt: Schema.Number,
  extracted: Schema.Array(ExtractedConversationSchema),
});

export type PromptBundle = Schema.Schema.Type<typeof PromptBundleSchema>;
