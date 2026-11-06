import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { inGroupTurns } from "../shared/chat-only";
import {
  chatTools,
  type ConversationKind,
} from "../bot-ports/conversation-kind";
import type { AgentRuntime } from "../bots/runtime";
import { defineAnchorTask } from "../shared/anchor-task";
import type { Agent } from "../contract/agents";
import { PASS_TOOL_NAME } from "../contract/tools";
import { GroupConversation, groupOf } from "./group-conversation";

export const GROUP_TURN_EXTENSION = "group-turn";

const GROUP_INSTRUCTIONS =
  "This conversation is your private working context for a group chat between the owner and several bots. Each input names the group and its members and lists the group messages you have not seen, each with its sender. Your final answer is posted to the group as your message; the owner and every member read it. Your tool calls, tool results, and memory stay private, so share only what the group needs. Mentioning a member with @ and their exact name wakes them, so mention a bot only when you need it to respond, and never to thank or acknowledge it. Answer when you are addressed or have something the others have not said. React with one emoji to acknowledge a message without answering. Otherwise call `pass` to stay silent; silence is often right when other bots have answered. Mention the owner as @owner only when you need their attention: it notifies them. Memories you save here go to your own memory, never to shared memory.";

// Owns a member's group conversation, so it outlives the bot chat's turns and Esc, like a coding job's anchor.
const GroupAnchor = defineAnchorTask("crumble.group-anchor");

function groupTurnExtension() {
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

export function groupConversations(): ConversationKind {
  const extension = groupTurnExtension();

  return {
    extension,
    recognize: async (reader, conversationId, context) => {
      if (!(await groupOf(reader, conversationId, context))) return undefined;

      return {
        tools: (parts) =>
          chatTools(parts, parts.offered.filter(inGroupTurns), [
            ...(extension.tools ?? []),
          ]),
        extensions: (parts) => [
          parts.memoryExtension,
          parts.skillExtension,
          ...parts.offered.filter(inGroupTurns),
          extension,
          parts.visionExtension,
        ],
        prompt: { addition: GROUP_INSTRUCTIONS },
      };
    },
  };
}

export const openGroupConversation = (
  runtime: Pick<AgentRuntime, "openAnchored">,
  agent: Agent,
  groupId: string,
) =>
  runtime.openAnchored(agent, GroupAnchor, async (tx, id) => {
    (await tx.doc(GroupConversation, id)).groupId = groupId;
  });
