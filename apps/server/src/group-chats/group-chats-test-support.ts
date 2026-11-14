import { Effect, Layer, ManagedRuntime } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { Bots } from "../bots/bots";
import type { ConversationRepository } from "../bot-store/conversation-repository";
import type { ExecutionRepository } from "../bot-store/execution-repository";
import type { BotRuntime } from "../bots/runtime";
import type { Library } from "../files/library";
import type { ChatAttention } from "../push/chat-attention";
import { layerOfRunner, type Runner } from "../shared/runner";
import type { GroupChatRepository } from "./group-chat-repository";
import {
  GroupChats,
  groupChatsAccess,
  GroupTranscriptStore,
  type GroupChatsAccess,
} from "./group-chats";
import type { GroupTranscripts } from "./group-transcripts";

export function standaloneGroupChats(
  bots: {
    effects: Runner<
      | Bots
      | BotRuntime
      | AgentRepository
      | ExecutionRepository
      | ConversationRepository
      | ChatAttention
    >;
    store: { runtime: Runner<GroupChatRepository | Library> };
  },
  transcripts: GroupTranscripts,
): GroupChatsAccess & {
  service: GroupChats["Service"];
  close(): Promise<void>;
} {
  const chats = ManagedRuntime.make(
    GroupChats.layer.pipe(
      Layer.provide(GroupTranscriptStore.layer(() => transcripts)),
      Layer.provide(layerOfRunner(bots.effects)),
      Layer.provide(layerOfRunner(bots.store.runtime)),
    ),
  );

  const service = chats.runSync(GroupChats.use(Effect.succeed));

  return {
    ...groupChatsAccess(service),
    service,
    close: () => chats.dispose(),
  };
}
