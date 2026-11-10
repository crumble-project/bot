import { pi } from "../shared/app-errors";
import { Effect, Semaphore } from "effect";
import type { CallEventData } from "../transcript/entries";
import type { BotMessageEvent } from "../transcript/transcript";
import type { Agent } from "../contract/agents";
import type { AppError } from "../shared/errors";
import type { ChatSnapshot } from "./bots";
import type { BotsAnnouncements } from "./bots-announcements";
import type { BotsContext } from "./bots-context";
import type { BotsLookup } from "./bots-lookup";
import type { BotsNotifications } from "./bots-notifications";

type ChatDeps = {
  lookup: BotsLookup;
  snapshot: (
    conversationId: string,
    options?: { limit?: number | undefined },
  ) => Effect.Effect<ChatSnapshot, AppError>;
  notifications: BotsNotifications;
  announcements: BotsAnnouncements;
};

export type BotsChat = ReturnType<typeof botsChat>;

export const botsChat = (context: BotsContext, deps: ChatDeps) => {
  const { chatOpenings, conversations, runtime } = context;
  const { agent } = deps.lookup;
  const { changed } = deps.notifications;
  const { forkPreview } = deps.announcements;

  const chat = Effect.fn("Bots.chat")(function* (agentId: string) {
    return yield* Semaphore.withPermit(
      chatOpenings(agentId),
      Effect.gen(function* () {
        const owner = yield* agent(agentId);
        const existing = yield* conversations.chatOf(agentId);

        if (existing)
          return existing.archived
            ? (yield* conversations.setArchived(existing.id, false))!
            : existing;

        return yield* conversations.create(
          { agentId, title: owner.name, chat: true },
          yield* pi(() => runtime.openChat(owner)),
        );
      }),
    );
  });

  const chatSnapshot = (
    agentId: string,
    options: { limit?: number | undefined } = {},
  ) =>
    chat(agentId).pipe(
      Effect.flatMap((opened) => deps.snapshot(opened.id, options)),
    );

  const record = Effect.fnUntraced(function* (
    agentId: string,
    write: (owner: Agent, conversationId: string) => Promise<void>,
  ) {
    const opened = yield* chat(agentId);
    const owner = yield* agent(agentId);

    yield* pi(() => write(owner, opened.id));
    yield* changed(opened.id);
    yield* forkPreview(agentId, opened.id, agentId);
  });

  const recordBotMessage = Effect.fn("Bots.recordBotMessage")(function* (
    agentId: string,
    event: BotMessageEvent,
    requestId: string,
  ) {
    yield* record(agentId, (owner, conversationId) =>
      runtime.recordBotMessage(owner, conversationId, event, requestId),
    );
  });

  const recordCallEvent = Effect.fn("Bots.recordCallEvent")(function* (
    agentId: string,
    event: CallEventData,
    requestId: string,
  ) {
    yield* record(agentId, (owner, conversationId) =>
      runtime.recordCallEvent(owner, conversationId, event, requestId),
    );
  });

  return { chat, chatSnapshot, recordBotMessage, recordCallEvent };
};
