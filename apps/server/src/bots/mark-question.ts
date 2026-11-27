import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { MARK_QUESTION_TOOL_NAME } from "../contract/tools";

export function markQuestionExtension() {
  const markQuestion = defineTool({
    name: MARK_QUESTION_TOOL_NAME,
    description:
      'Call this right before you end your turn with a question that you need the owner to answer before you can go on. Then write the question in plain text as your reply. Do not call it for rhetorical or courtesy questions, such as "Anything else?".',
    parameters: Type.Object({}),
    callers: ["model"],
    replay: "safe",
    execute: async () => ({
      output: [
        {
          type: "text" as const,
          text: "Marked. Write your question as your reply now.",
        },
      ],
    }),
  });

  return defineExtension({ name: "mark_question", tools: [markQuestion] });
}

export const markQuestionTools = Layer.effectDiscard(
  Effect.flatMap(BotExtensions, (extensions) =>
    extensions.register(ExtensionPosition.markQuestion, () => [
      markQuestionExtension(),
    ]),
  ),
);
