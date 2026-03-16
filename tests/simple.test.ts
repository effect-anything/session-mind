import { describe, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";

describe("simple test", () => {
  layer(Layer.empty)((it) => {
    it.effect(
      "pass1",
      Effect.fn(function* () {
        yield* Effect.logTrace("OK");
      }),
    );
  });
});
