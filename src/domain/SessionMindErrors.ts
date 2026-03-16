import * as Schema from "effect/Schema";

export const SessionMindErrorDetailsSchema = Schema.Record(Schema.String, Schema.Json);

export type SessionMindErrorDetails = Schema.Schema.Type<typeof SessionMindErrorDetailsSchema>;

export const ExtractionErrorCodeSchema = Schema.Literals([
  "SESSION_NOT_FOUND",
  "SESSION_READ_FAILED",
  "MESSAGE_PARSE_FAILED",
  "PART_PARSE_FAILED",
  "EMPTY_CONVERSATION",
  "UNSUPPORTED_SESSION_FORMAT",
]);

export type ExtractionErrorCode = Schema.Schema.Type<typeof ExtractionErrorCodeSchema>;

export const ExtractionErrorContextSchema = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  sessionPath: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  partId: Schema.optional(Schema.String),
  details: Schema.optional(SessionMindErrorDetailsSchema),
});

export type ExtractionErrorContext = Schema.Schema.Type<typeof ExtractionErrorContextSchema>;

export class ExtractionError extends Schema.TaggedErrorClass<ExtractionError>()("ExtractionError", {
  code: ExtractionErrorCodeSchema,
  message: Schema.String,
  context: ExtractionErrorContextSchema,
}) {}

export const PromptGenerationErrorCodeSchema = Schema.Literals([
  "EMPTY_EXTRACTION_INPUT",
  "PROMPT_TEMPLATE_INVALID",
  "PROMPT_TEMPLATE_RENDER_FAILED",
  "PROMPT_TOO_LARGE",
  "PROMPT_SERIALIZATION_FAILED",
]);

export type PromptGenerationErrorCode = Schema.Schema.Type<typeof PromptGenerationErrorCodeSchema>;

export const PromptGenerationErrorContextSchema = Schema.Struct({
  sourceSessionIds: Schema.Array(Schema.String),
  topicHint: Schema.optional(Schema.String),
  templateName: Schema.optional(Schema.String),
  promptLength: Schema.optional(Schema.Number),
  details: Schema.optional(SessionMindErrorDetailsSchema),
});

export type PromptGenerationErrorContext = Schema.Schema.Type<
  typeof PromptGenerationErrorContextSchema
>;

export class PromptGenerationError extends Schema.TaggedErrorClass<PromptGenerationError>()(
  "PromptGenerationError",
  {
    code: PromptGenerationErrorCodeSchema,
    message: Schema.String,
    context: PromptGenerationErrorContextSchema,
  },
) {}

export const SubprocessErrorCodeSchema = Schema.Literals([
  "SUBPROCESS_SPAWN_FAILED",
  "SUBPROCESS_EXITED_NON_ZERO",
  "SUBPROCESS_TIMED_OUT",
  "SUBPROCESS_PROTOCOL_VIOLATION",
  "SUBPROCESS_IO_FAILED",
]);

export type SubprocessErrorCode = Schema.Schema.Type<typeof SubprocessErrorCodeSchema>;

export const SubprocessErrorContextSchema = Schema.Struct({
  command: Schema.String,
  args: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  outputDir: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String),
  timeoutMs: Schema.optional(Schema.Number),
  details: Schema.optional(SessionMindErrorDetailsSchema),
});

export type SubprocessErrorContext = Schema.Schema.Type<typeof SubprocessErrorContextSchema>;

export class SubprocessError extends Schema.TaggedErrorClass<SubprocessError>()("SubprocessError", {
  code: SubprocessErrorCodeSchema,
  message: Schema.String,
  context: SubprocessErrorContextSchema,
}) {}

export const ValidationErrorCodeSchema = Schema.Literals([
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_EMPTY",
  "ARTIFACT_INVALID_FORMAT",
  "ARTIFACT_TOO_SHORT",
  "ARTIFACT_CHECK_FAILED",
]);

export type ValidationErrorCode = Schema.Schema.Type<typeof ValidationErrorCodeSchema>;

export const ValidationErrorContextSchema = Schema.Struct({
  artifactPath: Schema.String,
  sessionId: Schema.optional(Schema.String),
  rule: Schema.optional(Schema.String),
  actualLength: Schema.optional(Schema.Number),
  minimumLength: Schema.optional(Schema.Number),
  details: Schema.optional(SessionMindErrorDetailsSchema),
});

export type ValidationErrorContext = Schema.Schema.Type<typeof ValidationErrorContextSchema>;

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("ValidationError", {
  code: ValidationErrorCodeSchema,
  message: Schema.String,
  context: ValidationErrorContextSchema,
}) {}

export const StateErrorCodeSchema = Schema.Literals([
  "STATE_READ_FAILED",
  "STATE_WRITE_FAILED",
  "STATE_TRANSITION_INVALID",
  "STATE_RECOVERY_FAILED",
  "STATE_CORRUPTED",
]);

export type StateErrorCode = Schema.Schema.Type<typeof StateErrorCodeSchema>;

export const StateErrorContextSchema = Schema.Struct({
  stateFilePath: Schema.String,
  sessionId: Schema.optional(Schema.String),
  currentState: Schema.optional(Schema.String),
  nextState: Schema.optional(Schema.String),
  retryCount: Schema.optional(Schema.Number),
  details: Schema.optional(SessionMindErrorDetailsSchema),
});

export type StateErrorContext = Schema.Schema.Type<typeof StateErrorContextSchema>;

export class StateError extends Schema.TaggedErrorClass<StateError>()("StateError", {
  code: StateErrorCodeSchema,
  message: Schema.String,
  context: StateErrorContextSchema,
}) {}

export const SessionMindErrorSchema = Schema.Union([
  ExtractionError,
  PromptGenerationError,
  SubprocessError,
  ValidationError,
  StateError,
]);

export type SessionMindError = Schema.Schema.Type<typeof SessionMindErrorSchema>;
