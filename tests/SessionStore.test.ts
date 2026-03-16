import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/services/SessionStore.ts";

const tempDirectories: Array<string> = [];
const originalHome = process.env["HOME"];

const createTempHome = async () => {
  const directory = await mkdtemp(join(tmpdir(), "session-mind-store-"));
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

describe("SessionStore", () => {
  it("does not open the OpenCode database until a store method is used", async () => {
    await createTempHome();

    await expect(
      Effect.runPromise(Effect.provide(Effect.void, SessionStore.layer)),
    ).resolves.toBeUndefined();
  });
});
