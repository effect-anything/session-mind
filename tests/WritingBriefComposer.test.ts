import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ExtractedConversation } from "../src/domain/Session.ts";
import { WritingBriefComposer } from "../src/services/WritingBriefComposer.ts";

const extractedConversation: ExtractedConversation = {
  session: {
    id: "session-1",
    title: "New session - 2026-03-13T16:13:33.782Z",
    directory: "/workspace",
    timeCreated: 1,
    timeUpdated: 2,
    projectId: "project-1",
  },
  turns: [
    {
      role: "user",
      content: "我们想做一个面向普通用户的 AI 产品，先帮我们梳理方向和切入点。",
      timestamp: 1,
      sessionId: "session-1",
      messageId: "message-1",
    },
    {
      role: "assistant",
      content: "先收敛问题，再收敛市场和切入方式。",
      timestamp: 2,
      sessionId: "session-1",
      messageId: "message-2",
    },
  ],
  extractedAt: 3,
  stats: {
    totalMessages: 2,
    totalParts: 2,
    keptTurns: 2,
    droppedToolParts: 0,
    droppedReasoningParts: 0,
    droppedStepParts: 0,
    droppedEmptyTextParts: 0,
  },
};

describe("WritingBriefComposer", () => {
  it("builds an editorial brief and keeps raw transcript content in extracted only", async () => {
    const bundle = await Effect.runPromise(
      Effect.gen(function* () {
        const composer = yield* WritingBriefComposer;
        return yield* composer.compose([extractedConversation]);
      }).pipe(Effect.provide(WritingBriefComposer.layer)),
    );

    expect(bundle.topicHint).toContain("我们想做一个面向普通用户的 AI 产品");
    expect(bundle.writingBrief).toContain("Editorial goal:");
    expect(bundle.writingBrief).toContain("external-facing essay");
    expect(bundle.writingBrief).toContain(
      "Use the extracted conversations array as the raw source material.",
    );
    expect(bundle.writingBrief).not.toContain("USER:");
    expect(bundle.writingBrief).not.toContain("ASSISTANT:");
    expect(bundle.writingBrief).not.toContain(extractedConversation.turns[1]!.content);
    expect(bundle.extracted[0]?.turns[0]?.content).toBe(extractedConversation.turns[0]!.content);
  });
});
