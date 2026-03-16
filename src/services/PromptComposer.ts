import { Effect, Layer, ServiceMap } from "effect";
import { type ExtractedConversation, type PromptBundle } from "../domain/Session";

export class PromptComposer extends ServiceMap.Service<
  PromptComposer,
  {
    compose(extracted: ReadonlyArray<ExtractedConversation>): Effect.Effect<PromptBundle>;
  }
>()("session-article/PromptComposer") {
  static readonly layer = Layer.succeed(
    PromptComposer,
    PromptComposer.of({
      compose: Effect.fn("PromptComposer.compose")(function* (
        extracted: ReadonlyArray<ExtractedConversation>,
      ) {
        const sourceSessionIds = extracted.map((item) => item.session.id);
        const topicHint = extracted.map((item) => item.session.title).join(" / ");

        const sourceText = extracted
          .map((item, index) => {
            const turns = item.turns
              .map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`)
              .join("\n\n");

            return [
              `## Session ${index + 1}`,
              `- ID: ${item.session.id}`,
              `- Title: ${item.session.title}`,
              `- Directory: ${item.session.directory}`,
              `- Kept turns: ${item.stats.keptTurns}`,
              "",
              turns,
            ].join("\n");
          })
          .join("\n\n");

        const prompt = [
          "你现在要根据以下 OpenCode session 提取内容来协助写文章。",
          "",
          "目标：",
          "- 提炼真实问题、关键洞察、解决路径和有价值的表达",
          "- 不要复述工具调用、bash 输出、技能加载、推理内容",
          "- 重点保留用户问题、AI 最终回答、关键建议、可复用框架",
          "- 输出一篇适合继续打磨的中文文章初稿或详细提纲",
          "",
          "写作要求：",
          "- 保持信息密度高，但语言自然",
          "- 优先写出对读者真正有帮助的结论",
          "- 如果材料更适合写提纲，请先输出详细提纲，再补核心段落",
          "",
          "来源材料：",
          sourceText,
        ].join("\n");

        const bundle: PromptBundle = {
          topicHint,
          prompt,
          sourceSessionIds,
          generatedAt: Date.now(),
          extracted,
        };

        return bundle;
      }),
    }),
  );
}
