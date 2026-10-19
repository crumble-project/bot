import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { z } from "zod";

export const REACTION_TOOL_NAME = "react";

const EMOJI = /^\p{RGI_Emoji}$/v;

const reaction = z.object({ emoji: z.string().regex(EMOJI) });

/** The emoji of a successful `react` tool result; clients attach it to the latest input before it. */
export function reactionOf(message: {
  role: string;
  toolName?: string;
  isError?: boolean;
  toolDetails?: unknown;
}): string | undefined {
  if (
    message.role !== "toolResult" ||
    message.toolName !== REACTION_TOOL_NAME ||
    message.isError
  )
    return undefined;

  return reaction.safeParse(message.toolDetails).data?.emoji;
}

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
