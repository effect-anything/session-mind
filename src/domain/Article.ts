import * as Schema from "effect/Schema";

export const ArticleStatusSchema = Schema.Literals(["draft", "published"]);

export type ArticleStatus = Schema.Schema.Type<typeof ArticleStatusSchema>;
