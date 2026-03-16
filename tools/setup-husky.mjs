import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

if (!existsSync(".git") || process.env.CI === "true" || process.env.HUSKY === "0") {
  process.exit(0);
}

const binExtension = process.platform === "win32" ? ".cmd" : "";
const huskyBin = path.resolve("node_modules", ".bin", `husky${binExtension}`);
const result = spawnSync(huskyBin, {
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
