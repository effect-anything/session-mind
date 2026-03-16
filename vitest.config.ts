import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.repo/**",
      "**/.direnv/**",
      "**/.lalph/**",
      "**/.codemogger/**",
      "**/.specs/**",
      "**/.jj/**",
      "**/.{idea,git,cache,output,temp}/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: [
        "src/domain/SessionMindErrors.ts",
        "src/domain/SubprocessProtocol.ts",
        "src/services/ArtifactValidator.ts",
        "src/services/SubprocessSpawner.ts",
        "src/services/WorkflowStateManager.ts",
        "src/services/WorkflowSessionExtractor.ts",
        "src/services/SessionMindWorkflow.ts",
      ],
    },
  },
});
