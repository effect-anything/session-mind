import { describe, expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactValidator, defaultArtifactMinimumLength } from "../src/services/ArtifactValidator";

class TestFileSystemError extends Schema.TaggedErrorClass<TestFileSystemError>()(
  "TestFileSystemError",
  { message: Schema.String },
) {}

const toTestFileSystemError = (cause: unknown): TestFileSystemError =>
  new TestFileSystemError({
    message: cause instanceof Error ? cause.message : String(cause),
  });

const withTempDir = <A, E>(
  use: (dir: string) => Effect.Effect<A, E, ArtifactValidator>,
): Effect.Effect<A, E | TestFileSystemError, ArtifactValidator> =>
  Effect.tryPromise({
    try: () => mkdtemp(join(tmpdir(), "artifact-validator-")),
    catch: toTestFileSystemError,
  }).pipe(
    Effect.flatMap((dir) =>
      use(dir).pipe(
        Effect.ensuring(
          Effect.tryPromise({
            try: () => rm(dir, { recursive: true, force: true }),
            catch: toTestFileSystemError,
          }).pipe(Effect.ignore),
        ),
      ),
    ),
  );

describe("ArtifactValidator", () => {
  layer(ArtifactValidator.layer)((it) => {
    it.effect("accepts a non-empty markdown artifact above the minimum length", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const validator = yield* ArtifactValidator;
          const artifactPath = join(dir, "article.md");
          const content = [
            "# Session Mind Notes",
            "",
            "This artifact captures the important decisions, tradeoffs, and follow-up work from a session. ".repeat(
              4,
            ),
            "",
            "## Key Points",
            "",
            "- keep the useful conversation",
            "- remove noise",
            "- prepare article-ready input",
          ].join("\n");

          yield* Effect.tryPromise({
            try: () => writeFile(artifactPath, content, "utf8"),
            catch: toTestFileSystemError,
          });

          const result = yield* validator.validate(artifactPath);

          expect(result.isValid).toBe(true);
          expect(result.contentLength).toBeGreaterThanOrEqual(defaultArtifactMinimumLength);
          expect(result.issues).toEqual([]);
        }),
      ),
    );

    it.effect("reports a missing artifact file", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const validator = yield* ArtifactValidator;
          const artifactPath = join(dir, "missing.md");

          const result = yield* validator.validate(artifactPath);

          expect(result.isValid).toBe(false);
          expect(result.contentLength).toBe(0);
          expect(result.issues).toHaveLength(1);
          expect(result.issues[0]).toMatchObject({
            code: "file-not-found",
          });
        }),
      ),
    );

    it.effect("reports empty content and minimum length failures", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const validator = yield* ArtifactValidator;
          const artifactPath = join(dir, "empty.md");

          yield* Effect.tryPromise({
            try: () => writeFile(artifactPath, "   \n\t", "utf8"),
            catch: toTestFileSystemError,
          });

          const result = yield* validator.validate(artifactPath);

          expect(result.isValid).toBe(false);
          expect(result.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ code: "empty-content" }),
              expect.objectContaining({ code: "content-too-short" }),
            ]),
          );
        }),
      ),
    );

    it.effect("reports invalid markdown when a fenced code block is left open", () =>
      withTempDir((dir) =>
        Effect.gen(function* () {
          const validator = yield* ArtifactValidator;
          const artifactPath = join(dir, "broken.md");
          const content = [
            "# Broken Draft",
            "",
            "This text is long enough to clear the minimum length requirement while still leaving markdown malformed. ".repeat(
              3,
            ),
            "",
            "```ts",
            "const topic = 'session-mind';",
            "console.log(topic);",
          ].join("\n");

          yield* Effect.tryPromise({
            try: () => writeFile(artifactPath, content, "utf8"),
            catch: toTestFileSystemError,
          });

          const result = yield* validator.validate(artifactPath);

          expect(result.isValid).toBe(false);
          expect(result.issues).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                code: "invalid-markdown",
                line: 5,
              }),
            ]),
          );
        }),
      ),
    );
  });
});
