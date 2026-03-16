#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer, Schema, SchemaGetter } from "effect";
import * as Console from "effect/Console";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import PackageJson from "../package.json" with { type: "json" };
import { articleCommand } from "./commands/articleCommand.ts";
import { writeCommand } from "./commands/writeCommand.ts";
import { ExtractedConversationSchema, type SessionInfo } from "./domain/Session.ts";
import { ExtractionError } from "./domain/SessionMindErrors.ts";
import { ArticleManager } from "./services/ArticleManager.ts";
import { ArtifactValidator } from "./services/ArtifactValidator.ts";
import { ClaudeSessionProvider } from "./services/ClaudeSessionProvider.ts";
import { CodexSessionProvider } from "./services/CodexSessionProvider.ts";
import { OpenCodeSessionProvider } from "./services/OpenCodeSessionProvider.ts";
import { SessionExtractor } from "./services/SessionExtractor.ts";
import { SessionProviderRegistry } from "./services/SessionProviderRegistry.ts";
import { SessionProviderRegistryLive } from "./services/SessionProviderRegistryLive.ts";
import { SessionMindWorkflow } from "./services/SessionMindWorkflow.ts";
import { SessionStore } from "./services/SessionStore.ts";
import { SubprocessSpawner } from "./services/SubprocessSpawner.ts";
import { WorkflowReviewer } from "./services/WorkflowReviewer.ts";
import { WorkflowSessionExtractor } from "./services/WorkflowSessionExtractor.ts";
import { WorkflowStateManager } from "./services/WorkflowStateManager.ts";
import { WritingBriefComposer } from "./services/WritingBriefComposer.ts";

const extractorLayer = SessionExtractor.layer.pipe(Layer.provide(SessionStore.layer));
const openCodeProviderLayer = OpenCodeSessionProvider.layer.pipe(
  Layer.provide(Layer.mergeAll(SessionStore.layer, extractorLayer)),
);
const providerRegistryLayer = SessionProviderRegistryLive.pipe(
  Layer.provide(
    Layer.mergeAll(openCodeProviderLayer, ClaudeSessionProvider.layer, CodexSessionProvider.layer),
  ),
);

const workflowExtractorLayer = Layer.effect(WorkflowSessionExtractor)(
  Effect.gen(function* () {
    const providers = yield* SessionProviderRegistry;

    return WorkflowSessionExtractor.of({
      extract: (sessionId) =>
        providers.extract(sessionId).pipe(
          Effect.mapError(
            (cause) =>
              new ExtractionError({
                code: "SESSION_READ_FAILED",
                message: "Failed to extract session conversation",
                context: {
                  sessionId,
                  details: { cause: String(cause) },
                },
              }),
          ),
        ),
    });
  }),
).pipe(Layer.provide(Layer.mergeAll(extractorLayer, providerRegistryLayer)));

const workflowLayer = SessionMindWorkflow.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      workflowExtractorLayer,
      WritingBriefComposer.layer,
      ArtifactValidator.layer,
      SubprocessSpawner.layer,
      WorkflowStateManager.layer,
      WorkflowReviewer.layer,
    ),
  ),
);

const baseLayer = Layer.mergeAll(
  NodeServices.layer,
  SessionStore.layer,
  extractorLayer,
  openCodeProviderLayer,
  ClaudeSessionProvider.layer,
  CodexSessionProvider.layer,
  providerRegistryLayer,
  WritingBriefComposer.layer,
  WorkflowStateManager.layer,
);

const articleLayer = ArticleManager.layer.pipe(Layer.provide(baseLayer));

const mainLayer = Layer.mergeAll(baseLayer, articleLayer, workflowLayer);

const makePrettyJsonSchema = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(
    Schema.decodeTo(schema, {
      decode: SchemaGetter.parseJson(),
      encode: SchemaGetter.stringifyJson({ space: 2 }),
    }),
  );

const extractedConversationListJsonSchema = makePrettyJsonSchema(
  Schema.Array(ExtractedConversationSchema),
);
const sessionInfoDisplaySchema = Schema.Struct({
  id: Schema.String,
  source: Schema.optional(Schema.String),
  nativeId: Schema.optional(Schema.String),
  title: Schema.String,
  directory: Schema.String,
  timeCreated: Schema.String,
  timeUpdated: Schema.String,
  projectId: Schema.String,
});
const sessionInfoDisplayListJsonSchema = makePrettyJsonSchema(
  Schema.Array(sessionInfoDisplaySchema),
);

const encodeSessionInfoDisplayListJson = Schema.encodeEffect(sessionInfoDisplayListJsonSchema);
const encodeExtractedConversationListJson = Schema.encodeEffect(
  extractedConversationListJsonSchema,
);

const formatTimestamp = (value: number): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
};

const formatSessionInfoForDisplay = (session: SessionInfo) => ({
  ...session,
  timeCreated: formatTimestamp(session.timeCreated),
  timeUpdated: formatTimestamp(session.timeUpdated),
});

const list = Command.make(
  "list",
  {
    limit: Flag.integer("limit").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(10),
      Flag.withDescription("Number of recent sessions to show"),
    ),
    source: Flag.string("source").pipe(
      Flag.withDefault("all"),
      Flag.withDescription("Session source: all, opencode, codex, or claude"),
    ),
  },
  ({ limit, source }) =>
    Effect.gen(function* () {
      const providers = yield* SessionProviderRegistry;
      const sessions = yield* providers.listRecent(
        limit,
        source as "all" | "opencode" | "codex" | "claude",
      );
      yield* encodeSessionInfoDisplayListJson(sessions.map(formatSessionInfoForDisplay)).pipe(
        Effect.flatMap(Console.log),
      );
    }),
);

const sessionIdsArg = Argument.string("session-id").pipe(
  Argument.withDescription("One or more session ids. Use source:id to be explicit."),
  Argument.variadic({ min: 1 }),
);

const extract = Command.make(
  "extract",
  {
    sessionIds: sessionIdsArg,
    source: Flag.string("source").pipe(
      Flag.withDefault("all"),
      Flag.withDescription("Session source: all, opencode, codex, or claude"),
    ),
  },
  ({ sessionIds, source }) =>
    Effect.gen(function* () {
      const providers = yield* SessionProviderRegistry;
      const extracted = yield* Effect.forEach(sessionIds, (sessionId) =>
        providers.extract(sessionId, source as "all" | "opencode" | "codex" | "claude"),
      );
      yield* encodeExtractedConversationListJson(extracted).pipe(Effect.flatMap(Console.log));
    }),
);

const cli = Command.make("session-mind").pipe(
  Command.withDescription(
    "Inspect OpenCode, Codex, and Claude sessions and run article-writing workflows",
  ),
  Command.withSubcommands([list, extract, articleCommand, writeCommand]),
);

const main = Command.run(cli, { version: PackageJson.version }).pipe(Effect.provide(mainLayer));
const runnable = main as Effect.Effect<void, never, never>;

NodeRuntime.runMain(runnable);
