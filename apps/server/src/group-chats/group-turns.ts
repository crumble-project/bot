import { Type } from "@earendil-works/pi-ai";
import {
  defineDoc,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { defineAnchorTask } from "../shared/anchor-task";

export const PASS_TOOL_NAME = "pass";

export const GROUP_TURN_EXTENSION = "group-turn";

/** Extensions a group turn leaves out: no delegation, no coding jobs, and no lookup of other groups from a group. */
export const GROUP_EXCLUDED_EXTENSIONS = new Set([
  "coordination",
  "coding",
  "coding-job",
  "desktop",
  "desktop-job",
  "group-lookup",
]);

export const GROUP_INSTRUCTIONS =
  "This conversation is your private working context for a group chat between the owner and several bots. Each input names the group and its members and lists the group messages you have not seen, each with its sender. Your final answer is posted to the group as your message; the owner and every member read it. Your tool calls, tool results, and memory stay private, so share only what the group needs. Mentioning a member with @ and their exact name wakes them, so mention a bot only when you need it to respond, and never to thank or acknowledge it. Answer when you are addressed or have something the others have not said. React with one emoji to acknowledge a message without answering. Otherwise call `pass` to stay silent; silence is often right when other bots have answered. Mention the owner as @owner only when you need their attention: it notifies them. Memories you save here go to your own memory, never to shared memory.";

/** Marks a bot's conversation as its working context for one group chat. */
export const GroupConversation = defineDoc<{ groupId: string | null }>({
  kind: "crumble.group-conversation",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ groupId: null }),
  checkpointWhen: () => false,
});

// Owns a member's group conversation, so it outlives the bot chat's turns and Esc, like a coding job's anchor.
export const GroupAnchor = defineAnchorTask("crumble.group-anchor");

/** The `pass` tool and the anchor task; installed for every bot and offered only in group conversations. */
export function groupTurnExtension() {
  const pass = defineTool({
    name: PASS_TOOL_NAME,
    description:
      "Stay silent in the group chat: nothing is posted for this turn. Use it when the new messages need nothing from you. Finish any other tool calls, such as saving memory, first. Your turn ends here, so do not write a reply.",
    parameters: Type.Object({}),
    callers: ["model"],
    replay: "safe",
    execute: async () => ({
      output: [{ type: "text" as const, text: "Passed." }],
      control: { terminate: true },
    }),
  });

  return defineExtension({
    name: GROUP_TURN_EXTENSION,
    tools: [pass],
    tasks: [GroupAnchor],
  });
}
