import { Effect, Option, ServiceMap } from "effect";
import {
  parseSessionIdentifier,
  type ExtractedConversation,
  type SessionInfo,
  type SessionSource,
} from "../domain/Session.ts";
import { SessionProviderError } from "../errors/AppError.ts";

export type SessionSourceFilter = SessionSource | "all";

type ProviderLike = {
  readonly listRecent: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<SessionInfo>, SessionProviderError>;
  readonly getByNativeId: (
    nativeId: string,
  ) => Effect.Effect<Option.Option<SessionInfo>, SessionProviderError>;
  readonly extract: (
    nativeId: string,
  ) => Effect.Effect<ExtractedConversation, SessionProviderError>;
};

const makeLookupError = (message: string, sessionId?: string) =>
  new SessionProviderError({
    message,
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

export class SessionProviderRegistry extends ServiceMap.Service<
  SessionProviderRegistry,
  {
    listRecent(
      limit: number,
      source?: SessionSourceFilter,
    ): Effect.Effect<ReadonlyArray<SessionInfo>, SessionProviderError>;
    resolveSession(
      input: string,
      source?: SessionSourceFilter,
    ): Effect.Effect<SessionInfo, SessionProviderError>;
    extract(
      input: string,
      source?: SessionSourceFilter,
    ): Effect.Effect<ExtractedConversation, SessionProviderError>;
  }
>()("session-mind/SessionProviderRegistry") {}

export const makeSessionProviderRegistry = (
  providers: Readonly<Record<SessionSource, ProviderLike>>,
) => {
  const pickProviders = (
    source: SessionSourceFilter,
  ): ReadonlyArray<readonly [SessionSource, ProviderLike]> =>
    source === "all"
      ? [
          ["opencode", providers.opencode],
          ["codex", providers.codex],
          ["claude", providers.claude],
        ]
      : [[source, providers[source]]];

  const listRecent = Effect.fn("SessionProviderRegistry.listRecent")(function* (
    limit: number,
    source: SessionSourceFilter = "all",
  ) {
    const results = yield* Effect.forEach(pickProviders(source), ([, provider]) =>
      provider.listRecent(limit),
    );

    return results
      .flat()
      .slice()
      .sort((left, right) => right.timeUpdated - left.timeUpdated)
      .slice(0, limit);
  });

  const resolveSession = Effect.fn("SessionProviderRegistry.resolveSession")(function* (
    input: string,
    source: SessionSourceFilter = "all",
  ) {
    const identifier = parseSessionIdentifier(input, source === "all" ? "opencode" : source);
    const explicitSource = input.includes(":") ? identifier.source : undefined;
    const selectedSource = explicitSource ?? source;

    if (selectedSource !== "all") {
      const session = yield* providers[selectedSource].getByNativeId(identifier.nativeId);
      if (Option.isSome(session)) {
        return session.value;
      }

      return yield* makeLookupError(
        `No ${selectedSource} session was found for ${identifier.nativeId}`,
        input,
      );
    }

    const matches = yield* Effect.forEach(pickProviders("all"), ([, provider]) =>
      provider.getByNativeId(identifier.nativeId),
    ).pipe(Effect.map((options) => options.filter(Option.isSome).map((option) => option.value)));

    if (matches.length === 1) {
      return matches[0]!;
    }

    if (matches.length === 0) {
      return yield* makeLookupError(
        `No session was found for ${identifier.nativeId}. Pass --source or use source:id if it is not an OpenCode session.`,
        input,
      );
    }

    return yield* makeLookupError(
      `Session id ${identifier.nativeId} exists in multiple providers. Use source:id or --source to disambiguate.`,
      input,
    );
  });

  const extract = Effect.fn("SessionProviderRegistry.extract")(function* (
    input: string,
    source: SessionSourceFilter = "all",
  ) {
    const resolved = yield* resolveSession(input, source);
    const identifier = parseSessionIdentifier(resolved.id);
    return yield* providers[identifier.source].extract(identifier.nativeId);
  });

  return SessionProviderRegistry.of({
    listRecent,
    resolveSession,
    extract,
  });
};
