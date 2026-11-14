import { Context, Effect, Layer } from "effect";
import { accessOf, noServices, type Access } from "../shared/runner";
import { AgentRepository } from "../bot-store/agent-repository";
import { Bots } from "../bots/bots";
import { ChatAttention } from "../push/chat-attention";
import { ConversationRepository } from "../bot-store/conversation-repository";
import { ExecutionRepository } from "../bot-store/execution-repository";
import { BotRuntime } from "../bots/runtime";
import { Library } from "../files/library";
import {
  groupChatContext,
  groupChatState,
  type GroupChatServices,
} from "./group-chat-context";
import { groupChatMembers } from "./group-chat-members";
import { GroupChatRepository } from "./group-chat-repository";
import {
  groupChatsService,
  type GroupChatsService,
} from "./group-chat-service";
import type { GroupTranscripts } from "./group-transcripts";
import { groupTurnEngine, keepTurnsSettled } from "./group-turn-engine";
import { groupTurnInput } from "./group-turn-input";

export type {
  GroupActivity,
  GroupChatSnapshot,
  GroupMemberActivity,
  GroupMessageReceipt,
} from "./group-chat-types";

export class GroupTranscriptStore extends Context.Service<
  GroupTranscriptStore,
  GroupTranscripts
>()("crumble/group-chats/GroupTranscriptStore") {
  static layer(make: () => GroupTranscripts) {
    return Layer.effect(
      GroupTranscriptStore,
      Effect.acquireRelease(Effect.sync(make), (transcripts) =>
        Effect.promise(() => transcripts.close()),
      ),
    );
  }
}

export class GroupChats extends Context.Service<
  GroupChats,
  GroupChatsService
>()("crumble/group-chats/GroupChats") {
  static readonly layer = Layer.effect(
    GroupChats,
    Effect.gen(function* () {
      const services: GroupChatServices = {
        attention: yield* ChatAttention,
        groups: yield* GroupChatRepository,
        agents: yield* AgentRepository,
        executions: yield* ExecutionRepository,
        conversations: yield* ConversationRepository,
        transcripts: yield* GroupTranscriptStore,
        bots: yield* Bots,
        runtime: yield* BotRuntime,
        library: yield* Library,
      };

      const context = groupChatContext(services, yield* groupChatState);
      const members = groupChatMembers(context);

      const engine = groupTurnEngine({
        context,
        members,
        input: groupTurnInput(context),
      });

      yield* keepTurnsSettled(context, engine);

      return GroupChats.of(groupChatsService(context, members, engine));
    }),
  );
}

const SYNC_GROUP_CHATS = ["list", "get", "create", "activity"] as const;

export type GroupChatsAccess = Access<
  GroupChats["Service"],
  (typeof SYNC_GROUP_CHATS)[number]
>;

export const groupChatsAccess = (
  chats: GroupChats["Service"],
): GroupChatsAccess => accessOf(chats, noServices, SYNC_GROUP_CHATS);
