import * as Schema from "effect/Schema";
import { PromptBundleSchema, type PromptBundle } from "./Session";

export const SubprocessEnvironmentVariable = {
  promptBundle: "SESSION_MIND_PROMPT_BUNDLE",
  outputDir: "SESSION_MIND_OUTPUT_DIR",
  sessionId: "SESSION_MIND_SESSION_ID",
  timeoutSeconds: "SESSION_MIND_TIMEOUT_SECONDS",
} as const;

export const SubprocessEnvironmentVariableNameSchema = Schema.Union([
  Schema.Literal(SubprocessEnvironmentVariable.promptBundle),
  Schema.Literal(SubprocessEnvironmentVariable.outputDir),
  Schema.Literal(SubprocessEnvironmentVariable.sessionId),
  Schema.Literal(SubprocessEnvironmentVariable.timeoutSeconds),
]);

export type SubprocessEnvironmentVariableName = Schema.Schema.Type<
  typeof SubprocessEnvironmentVariableNameSchema
>;

/**
 * Raw environment variables as seen by the subprocess. All values arrive as strings.
 */
export interface SubprocessEnvironment {
  readonly SESSION_MIND_PROMPT_BUNDLE: string;
  readonly SESSION_MIND_OUTPUT_DIR: string;
  readonly SESSION_MIND_SESSION_ID: string;
  readonly SESSION_MIND_TIMEOUT_SECONDS: string;
}

export const SubprocessEnvironmentSchema = Schema.Struct({
  SESSION_MIND_PROMPT_BUNDLE: Schema.String,
  SESSION_MIND_OUTPUT_DIR: Schema.String,
  SESSION_MIND_SESSION_ID: Schema.String,
  SESSION_MIND_TIMEOUT_SECONDS: Schema.String,
});

export type SubprocessEnvironmentFromSchema = Schema.Schema.Type<
  typeof SubprocessEnvironmentSchema
>;

export const SubprocessExitCode = {
  success: 0,
  validationFailed: 1,
  timeout: 2,
  error: 3,
} as const;

export const SubprocessExitCodeSchema = Schema.Union([
  Schema.Literal(SubprocessExitCode.success),
  Schema.Literal(SubprocessExitCode.validationFailed),
  Schema.Literal(SubprocessExitCode.timeout),
  Schema.Literal(SubprocessExitCode.error),
]);

export type SubprocessExitCode = Schema.Schema.Type<typeof SubprocessExitCodeSchema>;

export interface SubprocessExitCodeDefinition {
  readonly code: SubprocessExitCode;
  readonly label: "success" | "validation-failed" | "timeout" | "error";
  readonly description: string;
}

export const SubprocessExitCodeDefinitions = [
  {
    code: SubprocessExitCode.success,
    label: "success",
    description: "Article generation finished and the expected artifact was written.",
  },
  {
    code: SubprocessExitCode.validationFailed,
    label: "validation-failed",
    description: "The subprocess completed, but the generated artifact failed validation.",
  },
  {
    code: SubprocessExitCode.timeout,
    label: "timeout",
    description: "The subprocess exceeded SESSION_MIND_TIMEOUT_SECONDS.",
  },
  {
    code: SubprocessExitCode.error,
    label: "error",
    description: "The subprocess failed unexpectedly and should report details on stderr.",
  },
] as const satisfies ReadonlyArray<SubprocessExitCodeDefinition>;

/**
 * The prompt bundle file should decode with the existing session domain schema.
 */
export const SubprocessPromptBundleSchema = PromptBundleSchema;

export type SubprocessPromptBundle = PromptBundle;

export interface SubprocessArtifactLocation {
  readonly outputDir: string;
  readonly sessionId: string;
  readonly artifactPath: string;
}

export const SubprocessArtifactLocationSchema = Schema.Struct({
  outputDir: Schema.String,
  sessionId: Schema.String,
  artifactPath: Schema.String,
});

export interface SubprocessInvocation {
  readonly promptBundlePath: string;
  readonly outputDir: string;
  readonly sessionId: string;
  readonly timeoutSeconds: number;
}

export const SubprocessInvocationSchema = Schema.Struct({
  promptBundlePath: Schema.String,
  outputDir: Schema.String,
  sessionId: Schema.String,
  timeoutSeconds: Schema.Number,
});

export interface SubprocessExecutionResult {
  readonly exitCode: SubprocessExitCode;
  readonly stdout: string;
  readonly stderr: string;
  readonly artifact: SubprocessArtifactLocation;
}

export const SubprocessExecutionResultSchema = Schema.Struct({
  exitCode: SubprocessExitCodeSchema,
  stdout: Schema.String,
  stderr: Schema.String,
  artifact: SubprocessArtifactLocationSchema,
});

export interface SubprocessStdioExpectation {
  readonly stdin: "unused";
  readonly stdout: "optional-text";
  readonly stderr: "optional-diagnostics";
}

/**
 * Stdio is intentionally lightweight:
 * - stdin is not part of the machine protocol; subprocesses should rely on env + prompt bundle file.
 * - stdout may contain human-readable progress or article previews, but parent code must not depend on it.
 * - stderr is reserved for diagnostics and failure details.
 */
export const SubprocessStdioExpectation = {
  stdin: "unused",
  stdout: "optional-text",
  stderr: "optional-diagnostics",
} as const satisfies SubprocessStdioExpectation;

export interface SubprocessProtocolSpecification {
  readonly environment: ReadonlyArray<SubprocessEnvironmentVariableName>;
  readonly promptBundleFile: "json";
  readonly promptBundleSchema: typeof SubprocessPromptBundleSchema;
  readonly artifactFileExtension: ".md";
  readonly stdio: SubprocessStdioExpectation;
  readonly exitCodes: ReadonlyArray<SubprocessExitCodeDefinition>;
}

export const SubprocessProtocol = {
  environment: [
    SubprocessEnvironmentVariable.promptBundle,
    SubprocessEnvironmentVariable.outputDir,
    SubprocessEnvironmentVariable.sessionId,
    SubprocessEnvironmentVariable.timeoutSeconds,
  ],
  promptBundleFile: "json",
  promptBundleSchema: SubprocessPromptBundleSchema,
  artifactFileExtension: ".md",
  stdio: SubprocessStdioExpectation,
  exitCodes: SubprocessExitCodeDefinitions,
} as const satisfies SubprocessProtocolSpecification;

export const resolveSubprocessArtifactPath = (
  outputDir: string,
  sessionId: string,
): `${string}/${string}.md` => `${outputDir.replace(/\/+$/, "")}/${sessionId}.md`;
