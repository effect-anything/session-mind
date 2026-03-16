import * as Schema from "effect/Schema";

export class DbError extends Schema.TaggedErrorClass<DbError>()("DbError", {
  message: Schema.String,
}) {}

export class SessionNotFoundError extends Schema.TaggedErrorClass<SessionNotFoundError>()(
  "SessionNotFoundError",
  {
    sessionId: Schema.String,
  },
) {}

export class ParseError extends Schema.TaggedErrorClass<ParseError>()("ParseError", {
  message: Schema.String,
  raw: Schema.optional(Schema.String),
}) {}

export class CliError extends Schema.TaggedErrorClass<CliError>()("CliError", {
  message: Schema.String,
}) {}

export class StateError extends Schema.TaggedErrorClass<StateError>()("StateError", {
  code: Schema.String,
  message: Schema.String,
  sessionId: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  currentStatus: Schema.optional(Schema.String),
  nextStatus: Schema.optional(Schema.String),
}) {}
