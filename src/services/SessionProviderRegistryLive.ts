import { Effect, Layer } from "effect";
import { ClaudeSessionProvider } from "./ClaudeSessionProvider.ts";
import { CodexSessionProvider } from "./CodexSessionProvider.ts";
import { OpenCodeSessionProvider } from "./OpenCodeSessionProvider.ts";
import { makeSessionProviderRegistry, SessionProviderRegistry } from "./SessionProviderRegistry.ts";

export const SessionProviderRegistryLive = Layer.effect(SessionProviderRegistry)(
  Effect.gen(function* () {
    const openCode = yield* OpenCodeSessionProvider;
    const codex = yield* CodexSessionProvider;
    const claude = yield* ClaudeSessionProvider;

    return makeSessionProviderRegistry({
      opencode: openCode,
      codex,
      claude,
    });
  }),
);
