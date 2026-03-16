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
