import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";

const outputPath = new URL("../dist/cli.js", import.meta.url);
const outputSourceMapPath = new URL("../dist/cli.js.map", import.meta.url);
const legacyBinaryPath = new URL("../dist/cli", import.meta.url);
const strayBundlePath = new URL("../src/cli.js", import.meta.url);
const straySourceMapPath = new URL("../src/cli.js.map", import.meta.url);

await fs.mkdir(new URL("../dist", import.meta.url), { recursive: true });
await fs.rm(legacyBinaryPath, { force: true });
await fs.rm(outputPath, { force: true });
await fs.rm(outputSourceMapPath, { force: true });
await fs.rm(strayBundlePath, { force: true });
await fs.rm(straySourceMapPath, { force: true });

execFileSync(
  "bun",
  [
    "build",
    "./src/cli.ts",
    "--target=node",
    "--minify",
    "--sourcemap=linked",
    "--outdir",
    "./dist",
    "--root",
    "./src",
  ],
  {
    stdio: "inherit",
  },
);

if (process.platform !== "win32") {
  await fs.chmod(outputPath, 0o755);
}
