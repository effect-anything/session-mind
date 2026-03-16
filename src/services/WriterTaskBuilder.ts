import { join } from "node:path";
import * as Schema from "effect/Schema";
import {
  parseSessionIdentifier,
  PromptBundleSchema,
  type PromptBundle,
} from "../domain/Session.ts";
import {
  SessionMindEnvironmentVariables,
  SessionMindOutputPaths,
} from "../domain/SubprocessProtocol.ts";

export const WriterPromptArgumentPlaceholder = "__SESSION_MIND_WRITER_PROMPT__";
export const AgentResultPathPlaceholder = "__SESSION_MIND_AGENT_RESULT_PATH__";

export const WriterTaskSchema = Schema.Struct({
  sessionId: Schema.String,
  outputDir: Schema.String,
  artifactPath: Schema.String,
  promptBundlePath: Schema.String,
  iteration: Schema.Number,
  prompt: Schema.String,
  promptBundle: PromptBundleSchema,
});

export type WriterTask = Schema.Schema.Type<typeof WriterTaskSchema>;

export type WriterRevisionContext = {
  readonly validationIssues: ReadonlyArray<string>;
  readonly previousArtifactPath: string;
};

const resolveArtifactPath = (outputDir: string, sessionId: string) =>
  join(
    outputDir,
    SessionMindOutputPaths.draftsDirectory,
    parseSessionIdentifier(sessionId).source,
    `${parseSessionIdentifier(sessionId).nativeId}.md`,
  );

const resolvePromptBundlePath = (outputDir: string, sessionId: string) =>
  join(
    outputDir,
    SessionMindOutputPaths.bundlesDirectory,
    parseSessionIdentifier(sessionId).source,
    `${parseSessionIdentifier(sessionId).nativeId}.prompt.json`,
  );

export const buildWriterTask = ({
  sessionId,
  outputDir,
  promptBundle,
  iteration = 1,
  revision,
}: {
  readonly sessionId: string;
  readonly outputDir: string;
  readonly promptBundle: PromptBundle;
  readonly iteration?: number;
  readonly revision?: WriterRevisionContext;
}): WriterTask => {
  const artifactPath = resolveArtifactPath(outputDir, sessionId);
  const promptBundlePath = resolvePromptBundlePath(outputDir, sessionId);
  const sourceSummary =
    promptBundle.sourceSessionIds.length === 0 ? "none" : promptBundle.sourceSessionIds.join(", ");
  const revisionPrompt =
    revision === undefined
      ? []
      : [
          `This is revision attempt ${iteration}.`,
          "The previous draft did not pass validation.",
          "Validation issues:",
          ...revision.validationIssues.map((issue) => `- ${issue}`),
          `Previous draft path: ${revision.previousArtifactPath}`,
          "Read the previous draft from that path if needed.",
          "Revise the draft and overwrite the same target file with a corrected version.",
        ];

  return {
    sessionId,
    outputDir,
    artifactPath,
    promptBundlePath,
    iteration,
    prompt: [
      "You are the session-mind writing subprocess.",
      "Do not ask follow-up questions or wait for interactive input.",
      `Attempt: ${iteration}`,
      `Session id: ${sessionId}`,
      `Write the final markdown article to ${artifactPath} and overwrite that file only.`,
      "Do not print the full article to stdout.",
      `Prompt bundle file: ${promptBundlePath}`,
      `Prompt bundle env: ${SessionMindEnvironmentVariables.promptBundle} (compact JSON string)`,
      "Treat the prompt bundle as the canonical input.",
      "Use its extracted conversations as source material and its writingBrief as editorial guidance.",
      `Topic hint: ${promptBundle.topicHint}`,
      `Source sessions: ${sourceSummary}`,
      "Write a strong Chinese article draft or, if needed, a detailed outline with core sections.",
      "Write as an external-facing publishable article, not a chat recap.",
      "Use a synthesized authorial voice rather than user/assistant framing.",
      "Avoid lines like '用户提到', '助手回答', '在这次对话中', or '你问我答' unless essential as evidence.",
      "Keep it useful, information-dense, natural, and focused on real problems, key insights, solution paths, and reusable framing.",
      "Do not include tool calls, shell output, skill-loading chatter, or reasoning traces.",
      ...revisionPrompt,
    ].join("\n"),
    promptBundle,
  };
};

export const resolvePromptArgs = (
  args: ReadonlyArray<string>,
  prompt: string,
  replacements?: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
  args.map((arg) => {
    if (arg === WriterPromptArgumentPlaceholder) {
      return prompt;
    }

    return replacements?.[arg] ?? arg;
  });

export const resolveWriterPromptArgs = (
  args: ReadonlyArray<string>,
  writerTask: WriterTask,
): ReadonlyArray<string> => resolvePromptArgs(args, writerTask.prompt);
