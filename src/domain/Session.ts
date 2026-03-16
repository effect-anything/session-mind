import * as Schema from "effect/Schema";

export const SessionInfoSchema = Schema.Struct({
  id: Schema.String,
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
  prompt: Schema.String,
  sourceSessionIds: Schema.Array(Schema.String),
  generatedAt: Schema.Number,
  extracted: Schema.Array(ExtractedConversationSchema),
});

export type PromptBundle = Schema.Schema.Type<typeof PromptBundleSchema>;
