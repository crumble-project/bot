import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import type { Agent } from "../contract/agents";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { chatOnly } from "../shared/chat-only";
import { GroupChats } from "./group-chats";
import { senderLabel } from "./group-transcripts";

const READ_LIMIT = 30;

/** Lets a bot answer questions about its group chats from its bot chat; group messages never enter that chat on their own. */
export function groupLookupExtension(
  agent: Pick<Agent, "id">,
  groups: GroupChats["Service"],
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
        return text({
          groups: await Effect.runPromise(groups.forMember(agent.id)),
        });

      if (!args.groupId) throw new Error("read needs a groupId from list");

      const page = await Effect.runPromise(
        groups.readAsMember(agent.id, args.groupId, {
          before: args.before,
          limit: READ_LIMIT,
        }),
      );

      return text({
        messages: page.messages.map((message) => ({
          entryId: message.entryId,
          sender: senderLabel(message.origin),
          text: message.content,
          ...(message.timestamp && {
            at: new Date(message.timestamp).toISOString(),
          }),
        })),
        before: page.hasMore ? page.oldestEntryId : null,
      });
    },
  });

  // A group turn has no lookup of other groups.
  return chatOnly(defineExtension({ name: "group-lookup", tools: [tool] }));
}

/** Offers every bot the lookup of its group chats. */
export const groupLookupTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const groups = yield* GroupChats;

    yield* (yield* BotExtensions).register(
      ExtensionPosition.groupLookup,
      (agent) => [groupLookupExtension(agent, groups)],
    );
  }),
);
