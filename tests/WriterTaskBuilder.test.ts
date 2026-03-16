import { describe, expect, it } from "vitest";
import type { PromptBundle } from "../src/domain/Session.ts";
import { SessionMindOutputPaths } from "../src/domain/SubprocessProtocol.ts";
import { buildWriterTask } from "../src/services/WriterTaskBuilder.ts";

const promptBundle: PromptBundle = {
  topicHint: "Session topic",
  writingBrief: "USER: 这是原始抽取内容，不应该再被内联进 prompt。",
  sourceSessionIds: ["session-1"],
  generatedAt: 1,
  extracted: [],
};

describe("WriterTaskBuilder", () => {
  it("keeps extracted source material in the prompt bundle json instead of duplicating it inline", () => {
    const writerTask = buildWriterTask({
      sessionId: "session-1",
      outputDir: "/tmp/session-mind",
      promptBundle,
    });

    expect(writerTask.prompt).toContain("Treat the prompt bundle as the canonical input.");
    expect(writerTask.prompt).toContain("Topic hint: Session topic");
    expect(writerTask.prompt).toContain("Source sessions: session-1");
    expect(writerTask.prompt).toContain("external-facing publishable article");
    expect(writerTask.prompt).toContain("not a chat recap");
    expect(writerTask.artifactPath).toBe(
      `/tmp/session-mind/${SessionMindOutputPaths.draftsDirectory}/opencode/session-1.md`,
    );
    expect(writerTask.prompt).toContain(
      "Prompt bundle env: SESSION_MIND_PROMPT_BUNDLE (compact JSON string)",
    );
    expect(writerTask.prompt).not.toContain(promptBundle.writingBrief);
    expect(writerTask.prompt).not.toContain("Previous draft:");
    expect(writerTask.prompt).not.toContain("```md");
    expect(writerTask.prompt).not.toContain("Source material:");
  });

  it("keeps revision prompts path-based instead of inlining the full previous draft", () => {
    const writerTask = buildWriterTask({
      sessionId: "session-1",
      outputDir: "/tmp/session-mind",
      promptBundle,
      iteration: 2,
      revision: {
        validationIssues: ["Tighten the title", "Remove dialogue framing"],
        previousArtifactPath: "/tmp/session-mind/drafts/session-1.previous-run.2.md",
      },
    });

    expect(writerTask.prompt).toContain("This is revision attempt 2.");
    expect(writerTask.prompt).toContain(
      "Previous draft path: /tmp/session-mind/drafts/session-1.previous-run.2.md",
    );
    expect(writerTask.prompt).toContain("Read the previous draft from that path if needed.");
    expect(writerTask.prompt).not.toContain(promptBundle.writingBrief);
    expect(writerTask.prompt).not.toContain("Source material:");
    expect(writerTask.prompt).not.toContain("Previous draft:");
    expect(writerTask.prompt).not.toContain("```md");
  });
});
