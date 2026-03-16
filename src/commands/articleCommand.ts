import { join } from "node:path";
import { Effect } from "effect";
import * as Console from "effect/Console";
import * as Argument from "effect/unstable/cli/Argument";
import * as Command from "effect/unstable/cli/Command";
import * as Flag from "effect/unstable/cli/Flag";
import { SessionMindOutputPaths } from "../domain/SubprocessProtocol.ts";
import { ArticleManager } from "../services/ArticleManager.ts";

const sessionIdArg = Argument.string("session-id").pipe(
  Argument.withDescription("OpenCode session id"),
);

const outputDirFlag = Flag.directory("output-dir").pipe(
  Flag.withDefault(join(process.cwd(), SessionMindOutputPaths.workflowRoot)),
  Flag.withDescription("Workflow output directory that stores draft and published articles"),
);

const statusCommand = Command.make(
  "status",
  {
    sessionId: sessionIdArg,
    outputDir: outputDirFlag,
  },
  ({ sessionId, outputDir }) =>
    Effect.gen(function* () {
      const articles = yield* ArticleManager;
      const article = yield* articles.getArticle(outputDir, sessionId);
      yield* Console.log(
        `${article.sessionId}: ${article.articleStatus} (${article.stage}) -> ${article.artifactPath}`,
      );
    }),
).pipe(Command.withDescription("Show the current article status and file path for a session"));

const publishCommand = Command.make(
  "publish",
  {
    sessionId: sessionIdArg,
    outputDir: outputDirFlag,
  },
  ({ sessionId, outputDir }) =>
    Effect.gen(function* () {
      const articles = yield* ArticleManager;
      const article = yield* articles.updateArticleStatus({
        outputDir,
        sessionId,
        nextStatus: "published",
      });
      yield* Console.log(`Published article for ${article.sessionId} at ${article.artifactPath}`);
    }),
).pipe(Command.withDescription("Move a completed draft article into the published directory"));

const draftCommand = Command.make(
  "draft",
  {
    sessionId: sessionIdArg,
    outputDir: outputDirFlag,
  },
  ({ sessionId, outputDir }) =>
    Effect.gen(function* () {
      const articles = yield* ArticleManager;
      const article = yield* articles.updateArticleStatus({
        outputDir,
        sessionId,
        nextStatus: "draft",
      });
      yield* Console.log(
        `Moved article for ${article.sessionId} back to draft at ${article.artifactPath}`,
      );
    }),
).pipe(
  Command.withDescription("Move a published article back into draft so it can be edited again"),
);

export const articleCommand = Command.make("article").pipe(
  Command.withDescription("Inspect and change article lifecycle state"),
  Command.withSubcommands([statusCommand, publishCommand, draftCommand]),
  Command.withExamples([
    {
      command: "session-mind article status session-123",
      description: "Inspect whether an article is a draft or published",
    },
    {
      command: "session-mind article publish session-123",
      description: "Publish a completed draft article",
    },
    {
      command: "session-mind article draft session-123",
      description: "Move a published article back to draft",
    },
  ]),
);
