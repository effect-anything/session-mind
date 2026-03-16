import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
  },
  outDir: "dist",
  platform: "node",
  format: "esm",
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  ignoreWatch: [
    ".git",
    ".repo",
    ".direnv",
    ".lalph",
    ".codemogger",
    ".specs",
    ".jj",
    "dist",
    "node_modules",
    "bun.lock",
    "flake.lock",
    ".output",
  ],
  exports: { all: true },
});
