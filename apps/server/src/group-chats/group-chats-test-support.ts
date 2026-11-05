import { Effect, Layer, ManagedRuntime } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { Bots } from "../bots/bots";
import type { ConversationRepository } from "../bot-store/conversation-repository";
import type { ExecutionRepository } from "../bot-store/execution-repository";
import type { BotRuntime } from "../bots/runtime";
import type { Runner } from "../shared/runner";
import type { GroupChatRepository } from "./group-chat-repository";
import {
  GroupChats,
  groupChatsAccess,
  GroupTranscriptStore,
  type GroupChatsAccess,
} from "./group-chats";
import type { GroupTranscripts } from "./group-transcripts";

/**
 * Group chats over standalone bots and `transcripts`, for a test without an account. Closing them stops their
 * background work and closes the transcripts; the bots stay open.
 */
export function standaloneGroupChats(
  bots: {
    effects: Runner<
      | Bots
      | BotRuntime
      | AgentRepository
      | ExecutionRepository
      | ConversationRepository
    >;
    store: { runtime: Runner<GroupChatRepository> };
  },
  transcripts: GroupTranscripts,
): GroupChatsAccess & {
  service: GroupChats["Service"];
  close(): Promise<void>;
} {
  const chats = ManagedRuntime.make(
    GroupChats.layer.pipe(
      Layer.provide(GroupTranscriptStore.layer(() => transcripts)),
      Layer.provide(
        Layer.succeedContext(
          bots.effects.runSync(
            Effect.context<
              | Bots
              | BotRuntime
              | AgentRepository
              | ExecutionRepository
              | ConversationRepository
            >(),
          ),
        ),
      ),
      Layer.provide(
        Layer.succeedContext(
          bots.store.runtime.runSync(Effect.context<GroupChatRepository>()),
        ),
      ),
    ),
  );

  const service = chats.runSync(GroupChats.use(Effect.succeed));

  return {
    ...groupChatsAccess(service),
    service,
    close: () => chats.dispose(),
  };
}
