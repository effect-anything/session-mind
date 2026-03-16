import { Effect, Layer, Schema, ServiceMap } from "effect";
import { readFile } from "node:fs/promises";

const ArtifactValidationIssueCodeSchema = Schema.Union([
  Schema.Literal("file-not-found"),
  Schema.Literal("file-read-failed"),
  Schema.Literal("empty-content"),
  Schema.Literal("content-too-short"),
  Schema.Literal("invalid-markdown"),
]);

export type ArtifactValidationIssueCode = Schema.Schema.Type<
  typeof ArtifactValidationIssueCodeSchema
>;

export const ArtifactValidationIssueSchema = Schema.Struct({
  code: ArtifactValidationIssueCodeSchema,
  message: Schema.String,
  details: Schema.optional(Schema.String),
  line: Schema.optional(Schema.Number),
  expectedMinimumLength: Schema.optional(Schema.Number),
  actualLength: Schema.optional(Schema.Number),
});

export type ArtifactValidationIssue = Schema.Schema.Type<typeof ArtifactValidationIssueSchema>;

export const ArtifactValidationResultSchema = Schema.Struct({
  artifactPath: Schema.String,
  isValid: Schema.Boolean,
  contentLength: Schema.Number,
  issues: Schema.Array(ArtifactValidationIssueSchema),
});

export type ArtifactValidationResult = Schema.Schema.Type<typeof ArtifactValidationResultSchema>;

export type ArtifactValidationOptions = {
  readonly minimumLength?: number;
};

export const defaultArtifactMinimumLength = 200;

type FenceState = {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly openedAtLine: number;
};

class ArtifactFileReadError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactFileReadError";
  }
}

export class ArtifactValidator extends ServiceMap.Service<
  ArtifactValidator,
  {
    validate(
      artifactPath: string,
      options?: ArtifactValidationOptions,
    ): Effect.Effect<ArtifactValidationResult>;
  }
>()("session-article/ArtifactValidator") {
  static readonly layer = Layer.succeed(
    ArtifactValidator,
    ArtifactValidator.of({
      validate: Effect.fn("ArtifactValidator.validate")(function* (
        artifactPath: string,
        options?: ArtifactValidationOptions,
      ) {
        const minimumLength = options?.minimumLength ?? defaultArtifactMinimumLength;
        const contentResult = yield* Effect.tryPromise({
          try: () => readFile(artifactPath, "utf8"),
          catch: (cause) =>
            new ArtifactFileReadError(getNodeErrorCode(cause), getErrorMessage(cause)),
        }).pipe(
          Effect.map((content) => ({ _tag: "content" as const, content })),
          Effect.catch((cause) =>
            Effect.succeed({
              _tag: "issue" as const,
              issue: makeFileReadIssue(artifactPath, cause),
            }),
          ),
        );

        if (contentResult._tag === "issue") {
          return {
            artifactPath,
            isValid: false,
            contentLength: 0,
            issues: [contentResult.issue],
          };
        }

        const normalizedContent = contentResult.content.replace(/^\uFEFF/, "");
        const trimmedContent = normalizedContent.trim();
        const issues = collectContentIssues(trimmedContent, minimumLength);

        return {
          artifactPath,
          isValid: issues.length === 0,
          contentLength: trimmedContent.length,
          issues,
        };
      }),
    }),
  );
}

const collectContentIssues = (
  content: string,
  minimumLength: number,
): Array<ArtifactValidationIssue> => {
  const issues: Array<ArtifactValidationIssue> = [];

  if (content.length === 0) {
    issues.push({
      code: "empty-content",
      message: "Artifact content is empty after trimming whitespace.",
      actualLength: 0,
    });
  }

  if (content.length < minimumLength) {
    issues.push({
      code: "content-too-short",
      message: `Artifact content must be at least ${minimumLength} characters.`,
      expectedMinimumLength: minimumLength,
      actualLength: content.length,
    });
  }

  const unclosedFence = findUnclosedFence(content);
  if (unclosedFence) {
    issues.push({
      code: "invalid-markdown",
      message: "Markdown contains an unclosed fenced code block.",
      details: `Fence opened with ${unclosedFence.marker.repeat(unclosedFence.length)} and was never closed.`,
      line: unclosedFence.openedAtLine,
    });
  }

  return issues;
};

const findUnclosedFence = (content: string): FenceState | undefined => {
  const lines = content.split(/\r?\n/u);
  let openFence: FenceState | undefined;

  for (const [index, line] of lines.entries()) {
    const fence = parseFence(line);
    if (!fence) {
      continue;
    }

    if (!openFence) {
      openFence = {
        marker: fence.marker,
        length: fence.length,
        openedAtLine: index + 1,
      };
      continue;
    }

    if (fence.marker === openFence.marker && fence.length >= openFence.length) {
      openFence = undefined;
    }
  }

  return openFence;
};

const parseFence = (line: string): Pick<FenceState, "marker" | "length"> | undefined => {
  const match = /^( {0,3})(`{3,}|~{3,})(.*)$/u.exec(line);
  const fence = match?.[2];
  if (!fence) {
    return undefined;
  }

  const marker = fence[0];
  if (marker !== "`" && marker !== "~") {
    return undefined;
  }

  return {
    marker,
    length: fence.length,
  };
};

const makeFileReadIssue = (artifactPath: string, cause: unknown): ArtifactValidationIssue => {
  const code = getNodeErrorCode(cause);

  if (code === "ENOENT") {
    return {
      code: "file-not-found",
      message: `Artifact file does not exist: ${artifactPath}`,
      details: getErrorMessage(cause),
    };
  }

  return {
    code: "file-read-failed",
    message: `Artifact file could not be read: ${artifactPath}`,
    details: getErrorMessage(cause),
  };
};

const getNodeErrorCode = (cause: unknown): string | undefined => {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return undefined;
  }

  const { code } = cause as { readonly code?: unknown };
  return typeof code === "string" ? code : undefined;
};

const getErrorMessage = (cause: unknown): string => {
  if (cause instanceof Error) {
    return cause.message;
  }

  return String(cause);
};
