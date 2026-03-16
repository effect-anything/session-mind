import { Effect, ServiceMap } from "effect";
import type { ExtractedConversation } from "../domain/Session";
import type { ExtractionError } from "../domain/SessionMindErrors";

export class WorkflowSessionExtractor extends ServiceMap.Service<
  WorkflowSessionExtractor,
  {
    extract(sessionId: string): Effect.Effect<ExtractedConversation, ExtractionError>;
  }
>()("session-mind/WorkflowSessionExtractor") {}
