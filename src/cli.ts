import * as BunServices from "@effect/platform-bun/BunServices";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import { Effect, Layer } from "effect";
import * as Console from "effect/Console";
import * as Command from "effect/unstable/cli/Command";
import * as Argument from "effect/unstable/cli/Argument";
import * as Flag from "effect/unstable/cli/Flag";
import { ExtractionError } from "./domain/SessionMindErrors";
import { writeCommand } from "./commands/writeCommand";
import { PromptComposer } from "./services/PromptComposer";
import { SessionExtractor } from "./services/SessionExtractor";
import { ArtifactValidator } from "./services/ArtifactValidator";
import { SessionStore } from "./services/SessionStore";
import { SessionMindWorkflow } from "./services/SessionMindWorkflow";
import { SubprocessSpawner } from "./services/SubprocessSpawner";
import { WorkflowSessionExtractor } from "./services/WorkflowSessionExtractor";
import { WorkflowStateManager } from "./services/WorkflowStateManager";

const extractorLayer = SessionExtractor.layer.pipe(Layer.provide(SessionStore.layer));
const workflowExtractorLayer = Layer.effect(WorkflowSessionExtractor)(
  Effect.gen(function* () {
    const extractor = yield* SessionExtractor;

    return WorkflowSessionExtractor.of({
      extract: (sessionId) =>
        extractor.extract(sessionId).pipe(
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
).pipe(Layer.provide(extractorLayer));
const workflowLayer = SessionMindWorkflow.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      workflowExtractorLayer,
      PromptComposer.layer,
      ArtifactValidator.layer,
      SubprocessSpawner.layer,
      WorkflowStateManager.layer,
    ),
  ),
);

const mainLayer = Layer.mergeAll(
  BunServices.layer,
  SessionStore.layer,
  extractorLayer,
  PromptComposer.layer,
  workflowLayer,
);

const list = Command.make(
  "list",
  {
    limit: Flag.integer("limit").pipe(
      Flag.withAlias("n"),
      Flag.withDefault(10),
      Flag.withDescription("Number of recent sessions to show"),
    ),
  },
  ({ limit }) =>
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const sessions = yield* store.listRecent(limit);
      yield* Console.log(JSON.stringify(sessions, null, 2));
    }),
);

const sessionIdsArg = Argument.string("session-id").pipe(
  Argument.withDescription("One or more OpenCode session ids"),
  Argument.variadic({ min: 1 }),
);

const extract = Command.make(
  "extract",
  {
    sessionIds: sessionIdsArg,
  },
  ({ sessionIds }) =>
    Effect.gen(function* () {
      const extractor = yield* SessionExtractor;
      const extracted = yield* Effect.forEach(sessionIds, (sessionId) =>
        extractor.extract(sessionId),
      );
      yield* Console.log(JSON.stringify(extracted, null, 2));
    }),
);

const prompt = Command.make(
  "prompt",
  {
    sessionIds: sessionIdsArg,
    json: Flag.boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the full prompt bundle as JSON"),
    ),
  },
  ({ sessionIds, json }) =>
    Effect.gen(function* () {
      const extractor = yield* SessionExtractor;
      const composer = yield* PromptComposer;
      const extracted = yield* Effect.forEach(sessionIds, (sessionId) =>
        extractor.extract(sessionId),
      );
      const bundle = yield* composer.compose(extracted);
      yield* Console.log(json ? JSON.stringify(bundle, null, 2) : bundle.prompt);
    }),
);

const cli = Command.make("session-article").pipe(
  Command.withDescription("Extract OpenCode sessions into article-ready prompts"),
  Command.withSubcommands([list, extract, prompt, writeCommand]),
);

const main = Command.run(cli, { version: "0.1.0" }).pipe(Effect.provide(mainLayer));

BunRuntime.runMain(main);
