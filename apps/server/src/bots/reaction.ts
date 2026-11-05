import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "./bot-extensions";
import { REACTION_TOOL_NAME } from "../contract/tools";
import { EMOJI } from "../transcript/tool-results";

/** Lets a bot acknowledge a message with an emoji instead of a text reply. */
export function reactionExtension() {
  const react = defineTool({
    name: REACTION_TOOL_NAME,
    description:
      "React to the message you are answering with one emoji instead of replying in text. Use it when the message needs no answer, such as thanks, an acknowledgement, or a fact to note; finish any other tool calls, such as saving memory, first. Your turn ends with the reaction, so do not write a reply.",
    parameters: Type.Object({
      emoji: Type.String({
        minLength: 1,
        maxLength: 16,
        description: "Exactly one emoji, e.g. 👍",
      }),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async ({ emoji }) => {
      if (!EMOJI.test(emoji)) throw new Error("Use exactly one emoji.");

      return {
        output: [{ type: "text" as const, text: "Reacted." }],
        details: { emoji },
        control: { terminate: true },
      };
    },
  });

  return defineExtension({ name: "reaction", tools: [react] });
}

/** Offers every bot the `react` tool. */
export const reactionTools = Layer.effectDiscard(
  BotExtensions.use((extensions) =>
    extensions.register(ExtensionPosition.reaction, () => [
      reactionExtension(),
    ]),
  ),
);
