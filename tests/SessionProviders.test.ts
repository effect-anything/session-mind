import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeSessionProvider } from "../src/services/ClaudeSessionProvider.ts";
import { CodexSessionProvider } from "../src/services/CodexSessionProvider.ts";

const tempDirectories: Array<string> = [];
const originalHome = process.env["HOME"];

const createTempHome = async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-mind-providers-"));
  tempDirectories.push(directory);
  process.env["HOME"] = directory;
  return directory;
};

afterEach(async () => {
  process.env["HOME"] = originalHome;
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("session providers", () => {
  it("reads Claude sessions from project files when the index is missing", async () => {
    const homeDirectory = await createTempHome();
    const projectDirectory = join(homeDirectory, ".claude", "projects", "project-a");
    const sessionId = "009cf4f4-4dcd-4cad-9379-2b11513dfd9f";

    await mkdir(projectDirectory, { recursive: true });
    await writeFile(
      join(projectDirectory, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "user",
          sessionId,
          cwd: "/tmp/claude-project",
          timestamp: "2026-03-11T06:50:28.100Z",
          isMeta: true,
          message: {
            role: "user",
            content:
              "<local-command-caveat>Caveat: ignore this local command wrapper.</local-command-caveat>",
          },
          uuid: "meta-1",
        }),
        JSON.stringify({
          type: "user",
          sessionId,
          cwd: "/tmp/claude-project",
          timestamp: "2026-03-11T06:50:28.200Z",
          message: {
            role: "user",
            content: "<command-name>/mcp</command-name><command-message>mcp</command-message>",
          },
          uuid: "meta-2",
        }),
        JSON.stringify({
          type: "user",
          sessionId,
          cwd: "/tmp/claude-project",
          timestamp: "2026-03-11T06:50:28.469Z",
          message: { role: "user", content: "fix claude provider fallback" },
          uuid: "user-1",
        }),
        JSON.stringify({
          type: "assistant",
          sessionId,
          cwd: "/tmp/claude-project",
          timestamp: "2026-03-11T06:50:33.702Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
          },
          uuid: "assistant-1",
        }),
      ].join("\n"),
      "utf8",
    );

    const sessions = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* ClaudeSessionProvider;
        return yield* provider.listRecent(10);
      }).pipe(Effect.provide(ClaudeSessionProvider.layer)),
    );

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: `claude:${sessionId}`,
      nativeId: sessionId,
      title: "fix claude provider fallback",
      directory: "/tmp/claude-project",
      projectId: "/tmp/claude-project",
    });
    expect(sessions[0]?.timeUpdated).toBeGreaterThanOrEqual(sessions[0]?.timeCreated ?? 0);
  });

  it("reads Codex sessions from rollout files even when they are missing from the index", async () => {
    const homeDirectory = await createTempHome();
    const codexDirectory = join(homeDirectory, ".codex");
    const sessionDirectory = join(codexDirectory, "sessions", "2026", "03", "17");
    const indexedId = "019cc187-98de-7620-80bb-1ceecaf894d5";
    const scannedOnlyId = "019cf9f0-43ff-7b11-bc4d-4598e7030177";

    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      join(codexDirectory, "session_index.jsonl"),
      JSON.stringify({
        id: indexedId,
        thread_name: "Indexed session title",
        updated_at: "2026-03-06T05:52:37.131943Z",
      }),
      "utf8",
    );

    await writeFile(
      join(sessionDirectory, `rollout-2026-03-06T13-03-35-${indexedId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-03-06T05:03:35.134Z",
          type: "session_meta",
          payload: {
            id: indexedId,
            timestamp: "2026-03-06T05:03:35.134Z",
            cwd: "/tmp/codex-indexed",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-06T05:04:06.543Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "indexed prompt" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    await writeFile(
      join(sessionDirectory, `rollout-2026-03-17T12-03-35-${scannedOnlyId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-03-17T03:56:38.789Z",
          type: "session_meta",
          payload: {
            id: scannedOnlyId,
            timestamp: "2026-03-17T03:56:38.789Z",
            cwd: "/tmp/codex-scanned",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-17T03:56:38.790Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /tmp/codex-scanned\n\n<INSTRUCTIONS>Ignore me</INSTRUCTIONS>",
              },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-17T03:56:39.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "real codex task title" }],
          },
        }),
      ].join("\n"),
      "utf8",
    );

    const sessions = await Effect.runPromise(
      Effect.gen(function* () {
        const provider = yield* CodexSessionProvider;
        return yield* provider.listRecent(10);
      }).pipe(Effect.provide(CodexSessionProvider.layer)),
    );

    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({
      id: `codex:${scannedOnlyId}`,
      nativeId: scannedOnlyId,
      title: "real codex task title",
      directory: "/tmp/codex-scanned",
      projectId: "/tmp/codex-scanned",
    });
    expect(sessions[1]).toMatchObject({
      id: `codex:${indexedId}`,
      nativeId: indexedId,
      title: "Indexed session title",
      directory: "/tmp/codex-indexed",
      projectId: "/tmp/codex-indexed",
    });
  });
});
