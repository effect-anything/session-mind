import { Effect, Layer, ServiceMap } from "effect";
import { type ExtractedConversation, type PromptBundle } from "../domain/Session.ts";

const genericSessionTitlePattern = /^New session\b/iu;

const normalizeInlineText = (text: string) => text.replace(/\s+/gu, " ").trim();

const truncateText = (text: string, maxLength: number) => {
  const normalized = normalizeInlineText(text);
  if (normalized.length <= maxLength) {
    return normalized;
  }

  const truncated = normalized.slice(0, maxLength).trimEnd();
  return `${truncated}...`;
};

const deriveTopicHint = (conversation: ExtractedConversation) => {
  const title = conversation.session.title.trim();
  if (title.length > 0 && !genericSessionTitlePattern.test(title)) {
    return title;
  }

  const firstUserTurn = conversation.turns.find(
    (turn) => turn.role === "user" && turn.content.trim().length > 0,
  );

  if (firstUserTurn !== undefined) {
    return truncateText(firstUserTurn.content, 48);
  }

  return conversation.session.id;
};

export class WritingBriefComposer extends ServiceMap.Service<
  WritingBriefComposer,
  {
    compose(extracted: ReadonlyArray<ExtractedConversation>): Effect.Effect<PromptBundle>;
  }
>()("session-mind/WritingBriefComposer") {
  static readonly layer = Layer.succeed(
    WritingBriefComposer,
    WritingBriefComposer.of({
      compose: Effect.fn("WritingBriefComposer.compose")(function* (
        extracted: ReadonlyArray<ExtractedConversation>,
      ) {
        const sourceSessionIds = extracted.map((item) => item.session.id);
        const topicHint = extracted.map(deriveTopicHint).join(" / ");
        const sourceOverview = extracted
          .map((item, index) => {
            return [
              `## Session ${index + 1}`,
              `- ID: ${item.session.id}`,
              `- Topic hint: ${deriveTopicHint(item)}`,
              `- Original title: ${item.session.title}`,
              `- Directory: ${item.session.directory}`,
              `- Kept turns: ${item.stats.keptTurns}`,
            ].join("\n");
          })
          .join("\n\n");

        const writingBrief = [
          `Topic hint: ${topicHint}`,
          "",
          "Editorial goal:",
          "- Turn the extracted sessions into a publishable Chinese article or a detailed outline.",
          "- Focus on real problems, key insights, solution paths, and reusable frameworks.",
          "- Write as an external-facing essay, not as a dialogue recap or turn-by-turn summary.",
          "- Synthesize the material into a coherent point of view instead of preserving user/assistant roles.",
          "- Ignore tool calls, shell output, skill-loading chatter, and reasoning traces.",
          "",
          "How to use the bundle:",
          "- Use this writingBrief as editorial guidance only.",
          "- Use the extracted conversations array as the raw source material.",
          "- Prefer grouping repeated ideas into themes instead of retelling the chat chronology.",
          "",
          "Source overview:",
          sourceOverview,
        ].join("\n");

        const bundle: PromptBundle = {
          topicHint,
          writingBrief,
          sourceSessionIds,
          generatedAt: Date.now(),
          extracted,
        };

        return bundle;
      }),
    }),
  );
}
