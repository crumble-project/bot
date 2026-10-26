import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { AgentRepository } from "../bots/agent-repository";
import { Bots } from "../bots/bots";
import { ConversationRepository } from "../bots/conversation-repository";
import { ExecutionRepository } from "../bots/execution-repository";
import { BotRuntime } from "../bots/runtime";
import type { TranscriptPage } from "../bots/transcript";
import type { AttachmentInput } from "../shared/attachments";
import type { GroupChat, GroupChatInput } from "../shared/domain";
import type { Runner } from "../shared/runner";
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
import type {
  GroupActivity,
  GroupAttachment,
  GroupChatSnapshot,
  GroupMessageReceipt,
  GroupMembership,
  PageOptions,
} from "./group-chat-types";
import type { GroupTranscripts } from "./group-transcripts";
import {
  groupTurnEngine,
  keepTurnsSettled,
  type GroupTurnDeps,
} from "./group-turn-engine";
import { groupTurnInput } from "./group-turn-input";

export type {
  GroupActivity,
  GroupChatSnapshot,
  GroupMemberActivity,
  GroupMessageReceipt,
  GroupMembership,
} from "./group-chat-types";

/** Each group chat's shared transcript files, closed with the layer's scope. */
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

/** Group chats between the owner and several bots: membership, the shared transcript, turns, and change notifications. */
export class GroupChats extends Context.Service<
  GroupChats,
  GroupChatsService
>()("crumble/group-chats/GroupChats") {
  static readonly layer = Layer.effect(
    GroupChats,
    Effect.gen(function* () {
      const services: GroupChatServices = {
        groups: yield* GroupChatRepository,
        agents: yield* AgentRepository,
        executions: yield* ExecutionRepository,
        conversations: yield* ConversationRepository,
        transcripts: yield* GroupTranscriptStore,
        bots: yield* Bots,
        runtime: yield* BotRuntime,
      };

      const context = groupChatContext(services, yield* groupChatState);
      const members = groupChatMembers(context);

      const turns: GroupTurnDeps = {
        context,
        members,
        input: groupTurnInput(context),
      };

      yield* keepTurnsSettled(turns);

      return GroupChats.of(
        groupChatsService(context, members, groupTurnEngine(turns)),
      );
    }),
  );
}

/** Group chats for code outside Effect, such as the HTTP handlers, with the API they had. */
export type GroupChatsAccess = {
  list(): GroupChat[];
  get(groupId: string): GroupChat;
  create(input: GroupChatInput): GroupChat;
  update(groupId: string, input: GroupChatInput): Promise<GroupChat>;
  delete(groupId: string): Promise<void>;
  post(
    groupId: string,
    content: string,
    requestId: string,
    options?: {
      replyTo?: string | undefined;
      attachments?: AttachmentInput[] | undefined;
    },
  ): Promise<GroupMessageReceipt>;
  stop(groupId: string): Promise<void>;
  activity(groupId: string): GroupActivity;
  attachment(
    groupId: string,
    entryId: string,
    index: number,
  ): Promise<GroupAttachment>;
  forMember(agentId: string): Promise<GroupMembership[]>;
  readAsMember(
    agentId: string,
    groupId: string,
    options: PageOptions,
  ): Promise<TranscriptPage>;
  history(groupId: string, options: PageOptions): Promise<TranscriptPage>;
  snapshot(
    groupId: string,
    options: { limit?: number | undefined },
  ): Promise<GroupChatSnapshot>;
  subscribe(groupId: string, callback: () => void): () => void;
  recover(): Promise<void>;
};

export const groupChatsAccess = (
  chats: GroupChats["Service"],
): GroupChatsAccess => ({
  list: () => Effect.runSync(chats.list),
  get: (groupId) => Effect.runSync(chats.get(groupId)),
  create: (input) => Effect.runSync(chats.create(input)),
  update: (groupId, input) => Effect.runPromise(chats.update(groupId, input)),
  delete: (groupId) => Effect.runPromise(chats.delete(groupId)),
  post: (groupId, content, requestId, options) =>
    Effect.runPromise(chats.post(groupId, content, requestId, options)),
  stop: (groupId) => Effect.runPromise(chats.stop(groupId)),
  activity: (groupId) => Effect.runSync(chats.activity(groupId)),
  attachment: (groupId, entryId, index) =>
    Effect.runPromise(chats.attachment(groupId, entryId, index)),
  forMember: (agentId) => Effect.runPromise(chats.forMember(agentId)),
  readAsMember: (agentId, groupId, options) =>
    Effect.runPromise(chats.readAsMember(agentId, groupId, options)),
  history: (groupId, options) =>
    Effect.runPromise(chats.history(groupId, options)),
  snapshot: (groupId, options) =>
    Effect.runPromise(chats.snapshot(groupId, options)),
  subscribe: chats.subscribe,
  recover: () => Effect.runPromise(chats.recover),
});

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
