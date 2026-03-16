import { Effect, ServiceMap } from "effect";
import type { ExtractedConversation } from "../domain/Session.ts";
import type { ExtractionError } from "../domain/SessionMindErrors.ts";

export class WorkflowSessionExtractor extends ServiceMap.Service<
  WorkflowSessionExtractor,
  {
    extract(sessionId: string): Effect.Effect<ExtractedConversation, ExtractionError>;
  }
>()("session-mind/WorkflowSessionExtractor") {}
