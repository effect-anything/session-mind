import { Effect, Layer, Option, ServiceMap } from "effect";
import {
  makeSessionKey,
  type ExtractedConversation,
  type SessionInfo,
  type SessionSource,
} from "../domain/Session.ts";
import { ParseError, SessionNotFoundError, SessionProviderError } from "../errors/AppError.ts";
import { SessionExtractor } from "./SessionExtractor.ts";
import { SessionStore } from "./SessionStore.ts";

const source: SessionSource = "opencode";

const toProviderError = (cause: unknown, sessionId?: string) =>
  new SessionProviderError({
    message: String(cause),
    source,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

const toSessionInfo = (session: Omit<SessionInfo, "source" | "nativeId">): SessionInfo => ({
  ...session,
  source,
  nativeId: session.id,
  id: makeSessionKey(source, session.id),
});

const toExtractedConversation = (conversation: ExtractedConversation): ExtractedConversation => ({
  ...conversation,
  session: toSessionInfo(conversation.session),
  turns: conversation.turns.map((turn) => ({
    ...turn,
    sessionId: makeSessionKey(source, turn.sessionId),
    source,
  })),
});

export class OpenCodeSessionProvider extends ServiceMap.Service<
  OpenCodeSessionProvider,
  {
    listRecent(limit: number): Effect.Effect<ReadonlyArray<SessionInfo>, SessionProviderError>;
    getByNativeId(
      nativeId: string,
    ): Effect.Effect<Option.Option<SessionInfo>, SessionProviderError>;
    extract(nativeId: string): Effect.Effect<ExtractedConversation, SessionProviderError>;
  }
>()("session-mind/OpenCodeSessionProvider") {
  static readonly layer = Layer.effect(OpenCodeSessionProvider)(
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const extractor = yield* SessionExtractor;

      const listRecent = Effect.fn("OpenCodeSessionProvider.listRecent")(function* (limit: number) {
        const sessions = yield* store
          .listRecent(limit)
          .pipe(Effect.mapError((cause) => toProviderError(cause)));
        return sessions.map(toSessionInfo);
      });

      const getByNativeId = Effect.fn("OpenCodeSessionProvider.getByNativeId")(function* (
        nativeId: string,
      ) {
        return yield* store.getSessionById(nativeId).pipe(
          Effect.map(toSessionInfo),
          Effect.map(Option.some),
          Effect.catchTags({
            SessionNotFoundError: () => Effect.succeed(Option.none()),
            DbError: (cause) => Effect.fail(toProviderError(cause, nativeId)),
            ParseError: (cause) => Effect.fail(toProviderError(cause, nativeId)),
          }),
        );
      });

      const extract = Effect.fn("OpenCodeSessionProvider.extract")(function* (nativeId: string) {
        return yield* extractor.extract(nativeId).pipe(
          Effect.map(toExtractedConversation),
          Effect.mapError((cause) => {
            if (
              cause instanceof SessionNotFoundError ||
              cause instanceof ParseError ||
              "_tag" in (cause as object)
            ) {
              return toProviderError(cause, nativeId);
            }

            return toProviderError(cause, nativeId);
          }),
        );
      });

      return OpenCodeSessionProvider.of({
        listRecent,
        getByNativeId,
        extract,
      });
    }),
  );
}
