import { Effect, Layer, ServiceMap } from "effect";
import { type ConversationTurn, type ExtractedConversation } from "../domain/Session.ts";
import { DbError, ParseError, SessionNotFoundError } from "../errors/AppError.ts";
import { SessionStore } from "./SessionStore.ts";

type MessageData = {
  readonly role?: string;
};

type PartData = {
  readonly type?: string;
  readonly text?: string;
};

export type SessionExtractorError = DbError | ParseError | SessionNotFoundError;

export class SessionExtractor extends ServiceMap.Service<
  SessionExtractor,
  {
    extract(sessionId: string): Effect.Effect<ExtractedConversation, SessionExtractorError>;
  }
>()("session-article/SessionExtractor") {
  static readonly layer = Layer.effect(SessionExtractor)(
    Effect.gen(function* () {
      const store = yield* SessionStore;

      const extract: (
        sessionId: string,
      ) => Effect.Effect<ExtractedConversation, SessionExtractorError> = Effect.fn(
        "SessionExtractor.extract",
      )(function* (sessionId: string) {
        const session = yield* store.getSessionById(sessionId);
        const messages = yield* store.getMessageRows(sessionId);
        const parts = yield* store.getPartRows(sessionId);

        const partsByMessage = new Map<string, Array<(typeof parts)[number]>>();
        for (const part of parts) {
          const current = partsByMessage.get(part.messageId) ?? [];
          current.push(part);
          partsByMessage.set(part.messageId, current);
        }

        let totalParts = 0;
        let droppedToolParts = 0;
        let droppedReasoningParts = 0;
        let droppedStepParts = 0;
        let droppedEmptyTextParts = 0;

        const turns: Array<ConversationTurn> = [];

        for (const message of messages) {
          const messageData = yield* Effect.try({
            try: () => JSON.parse(message.data) as MessageData,
            catch: () =>
              new ParseError({ message: "Failed to parse message JSON", raw: message.data }),
          });

          const role = messageData.role;
          if (role !== "user" && role !== "assistant") {
            continue;
          }

          const messageParts = partsByMessage.get(message.id) ?? [];
          totalParts += messageParts.length;

          const textSegments: Array<string> = [];

          for (const part of messageParts) {
            const partData = yield* Effect.try({
              try: () => JSON.parse(part.data) as PartData,
              catch: () => new ParseError({ message: "Failed to parse part JSON", raw: part.data }),
            });

            switch (partData.type) {
              case "text": {
                const text = partData.text?.trim() ?? "";
                if (text.length === 0) {
                  droppedEmptyTextParts += 1;
                } else {
                  textSegments.push(text);
                }
                break;
              }
              case "tool":
                droppedToolParts += 1;
                break;
              case "reasoning":
                droppedReasoningParts += 1;
                break;
              case "step-start":
              case "step-finish":
                droppedStepParts += 1;
                break;
              default:
                break;
            }
          }

          const content = textSegments.join("\n\n").trim();
          if (content.length === 0) {
            continue;
          }

          turns.push({
            role,
            content,
            timestamp: message.timeCreated,
            sessionId,
            messageId: message.id,
          });
        }

        const extracted: ExtractedConversation = {
          session,
          turns,
          extractedAt: Date.now(),
          stats: {
            totalMessages: messages.length,
            totalParts,
            keptTurns: turns.length,
            droppedToolParts,
            droppedReasoningParts,
            droppedStepParts,
            droppedEmptyTextParts,
          },
        };

        return extracted;
      });

      return SessionExtractor.of({ extract });
    }),
  );
}
