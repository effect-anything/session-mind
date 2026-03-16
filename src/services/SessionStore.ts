import type { DatabaseSync } from "node:sqlite";
import { Effect, Layer, Schema, ServiceMap } from "effect";
import { DbError, ParseError, SessionNotFoundError } from "../errors/AppError.ts";
import { SessionInfoSchema, type SessionInfo } from "../domain/Session.ts";

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

const databasePath = () => {
  const homeDirectory = process.env["HOME"];
  if (!homeDirectory) {
    throw new Error("HOME is not set");
  }

  return `${homeDirectory}/.local/share/opencode/opencode-local.db`;
};

const openDatabase = () =>
  Effect.tryPromise({
    try: async () => {
      const { DatabaseSync } = await import("node:sqlite");
      return new DatabaseSync(databasePath(), { readOnly: true });
    },
    catch: (cause) => new DbError({ message: String(cause) }),
  });

const runAll = <TRow>(database: DatabaseSync, query: string, parameters: ReadonlyArray<unknown>) =>
  Effect.try({
    try: () =>
      database.prepare(query).all(...(parameters as Array<any>)) as unknown as ReadonlyArray<TRow>,
    catch: (cause) => new DbError({ message: String(cause) }),
  });

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
  static readonly layer = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const decodeSession = Schema.decodeUnknownEffect(SessionInfoSchema);
      let database: DatabaseSync | undefined;

      const getDatabase = () =>
        Effect.gen(function* () {
          if (database !== undefined) {
            return database;
          }

          database = yield* openDatabase();
          return database;
        });

      const listRecent = Effect.fn("SessionStore.listRecent")(function* (limit: number) {
        const database = yield* getDatabase();
        const rows = yield* runAll<SessionRow>(
          database,
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
        );

        return yield* Effect.forEach(rows, (row) =>
          decodeSession(row).pipe(
            Effect.mapError((cause) => new ParseError({ message: String(cause) })),
          ),
        );
      });

      const getSessionById = Effect.fn("SessionStore.getSessionById")(function* (
        sessionId: string,
      ) {
        const database = yield* getDatabase();
        const rows = yield* runAll<SessionRow>(
          database,
          `SELECT id,
                title,
                directory,
                time_created AS timeCreated,
                time_updated AS timeUpdated,
                project_id AS projectId
         FROM session
         WHERE id = ?`,
          [sessionId],
        );

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
        const database = yield* getDatabase();
        return yield* runAll<MessageRow>(
          database,
          `SELECT id,
                session_id AS sessionId,
                time_created AS timeCreated,
                time_updated AS timeUpdated,
                data
         FROM message
         WHERE session_id = ?
         ORDER BY time_created ASC`,
          [sessionId],
        );
      });

      const getPartRows = Effect.fn("SessionStore.getPartRows")(function* (sessionId: string) {
        const database = yield* getDatabase();
        return yield* runAll<PartRow>(
          database,
          `SELECT id,
                message_id AS messageId,
                session_id AS sessionId,
                time_created AS timeCreated,
                data
         FROM part
         WHERE session_id = ?
         ORDER BY time_created ASC`,
          [sessionId],
        );
      });

      return SessionStore.of({
        listRecent,
        getSessionById,
        getMessageRows,
        getPartRows,
      });
    }),
  );
}
