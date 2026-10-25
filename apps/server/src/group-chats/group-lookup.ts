import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "../shared/domain";
import type { GroupChats } from "./group-chats";

export const GROUP_LOOKUP_EXTENSION = "group-lookup";

const READ_LIMIT = 30;

/** Lets a bot answer questions about its group chats from its bot chat; group messages never enter that chat on their own. */
export function groupLookupExtension(
  agent: Pick<Agent, "id">,
  groups: GroupChats,
) {
  const tool = defineTool({
    name: "group_chats",
    description:
      "Look up the group chats you belong to when the owner asks about them. `list` returns your groups with their members and newest message time. `read` (groupId; before: the `before` cursor of a previous read for older messages) returns up to 30 newest messages, oldest first, with their senders.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("list"), Type.Literal("read")]),
      groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      before: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    }),
    callers: ["model"],
    replay: "safe",
    execute: async (args) => {
      const text = (value: JsonValue) => ({
        output: [{ type: "text" as const, text: JSON.stringify(value) }],
      });

      if (args.action === "list")
        return text({ groups: await groups.forMember(agent.id) });

      if (!args.groupId) throw new Error("read needs a groupId from list");

      const page = await groups.readAsMember(agent.id, args.groupId, {
        before: args.before,
        limit: READ_LIMIT,
      });

      return text({
        messages: page.messages.map((message) => ({
          entryId: message.entryId,
          sender:
            message.origin?.kind === "owner"
              ? "Owner"
              : (message.origin?.name ?? "A bot"),
          text: message.content,
          ...(message.timestamp && {
            at: new Date(message.timestamp).toISOString(),
          }),
        })),
        before: page.hasMore ? page.oldestEntryId : null,
      });
    },
  });

  return defineExtension({ name: GROUP_LOOKUP_EXTENSION, tools: [tool] });
}
