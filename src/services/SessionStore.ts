import { Effect, Layer, Schema, ServiceMap } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { DbError, ParseError, SessionNotFoundError } from "../errors/AppError";
import { SessionInfoSchema, type SessionInfo } from "../domain/Session";

export type MessageRow = {
  readonly id: string;
  readonly sessionId: string;
  readonly timeCreated: number;
  readonly timeUpdated: number;
  readonly data: string;
};

export type PartRow = {
  readonly id: string;
  readonly messageId: string;
  readonly sessionId: string;
  readonly timeCreated: number;
  readonly data: string;
};

type SessionRow = SessionInfo & {
  readonly timeCreated: number;
  readonly timeUpdated: number;
};

export class SessionStore extends ServiceMap.Service<
  SessionStore,
  {
    listRecent(limit: number): Effect.Effect<ReadonlyArray<SessionInfo>, DbError | ParseError>;
    getSessionById(
      sessionId: string,
    ): Effect.Effect<SessionInfo, DbError | ParseError | SessionNotFoundError>;
    getMessageRows(sessionId: string): Effect.Effect<ReadonlyArray<MessageRow>, DbError>;
    getPartRows(sessionId: string): Effect.Effect<ReadonlyArray<PartRow>, DbError>;
  }
>()("session-article/SessionStore") {
  static readonly layer = Layer.effect(SessionStore)(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const decodeSession = Schema.decodeUnknownEffect(SessionInfoSchema);

      const listRecent = Effect.fn("SessionStore.listRecent")(function* (limit: number) {
        const rows = yield* sql
          .unsafe<SessionRow>(
            `SELECT id,
                  title,
                  directory,
                  time_created AS timeCreated,
                  time_updated AS timeUpdated,
                  project_id AS projectId
           FROM session
           ORDER BY time_updated DESC
           LIMIT ?`,
            [limit],
          )
          .pipe(Effect.mapError((cause) => new DbError({ message: String(cause) })));

        return yield* Effect.forEach(rows, (row) =>
          decodeSession(row).pipe(
            Effect.mapError((cause) => new ParseError({ message: String(cause) })),
          ),
        );
      });

      const getSessionById = Effect.fn("SessionStore.getSessionById")(function* (
        sessionId: string,
      ) {
        const rows = yield* sql
          .unsafe<SessionRow>(
            `SELECT id,
                  title,
                  directory,
                  time_created AS timeCreated,
                  time_updated AS timeUpdated,
                  project_id AS projectId
           FROM session
           WHERE id = ?`,
            [sessionId],
          )
          .pipe(Effect.mapError((cause) => new DbError({ message: String(cause) })));

        const row = rows[0];
        if (!row) {
          return yield* new SessionNotFoundError({ sessionId });
        }

        return yield* decodeSession(row).pipe(
          Effect.mapError((cause) => new ParseError({ message: String(cause) })),
        );
      });

      const getMessageRows = Effect.fn("SessionStore.getMessageRows")(function* (
        sessionId: string,
      ) {
        return yield* sql
          .unsafe<MessageRow>(
            `SELECT id,
                  session_id AS sessionId,
                  time_created AS timeCreated,
                  time_updated AS timeUpdated,
                  data
           FROM message
           WHERE session_id = ?
           ORDER BY time_created ASC`,
            [sessionId],
          )
          .pipe(Effect.mapError((cause) => new DbError({ message: String(cause) })));
      });

      const getPartRows = Effect.fn("SessionStore.getPartRows")(function* (sessionId: string) {
        return yield* sql
          .unsafe<PartRow>(
            `SELECT id,
                  message_id AS messageId,
                  session_id AS sessionId,
                  time_created AS timeCreated,
                  data
           FROM part
           WHERE session_id = ?
           ORDER BY time_created ASC`,
            [sessionId],
          )
          .pipe(Effect.mapError((cause) => new DbError({ message: String(cause) })));
      });

      return SessionStore.of({
        listRecent,
        getSessionById,
        getMessageRows,
        getPartRows,
      });
    }),
  ).pipe(
    Layer.provide(
      SqliteClient.layer({
        // @ts-expect-error
        filename: `${process.env.HOME}/.local/share/opencode/opencode-local.db`,
        readonly: true,
        readwrite: false,
        create: false,
      }),
    ),
  );
}
