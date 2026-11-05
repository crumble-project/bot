import { pi } from "../shared/app-errors";
import { Effect, Semaphore } from "effect";
import type { BotMessageEvent } from "../transcript/transcript";
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

/** The bot's chat: opening it once, then reading it and writing bot messages into it. */
export const botsChat = (context: BotsContext, deps: ChatDeps) => {
  const { chatOpenings, conversations, runtime } = context;
  const { agent } = deps.lookup;
  const { changed } = deps.notifications;
  const { forkPreview } = deps.announcements;

  /** The bot's one continuous chat, created on first use and stable across restarts. */
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

  const recordBotMessage = Effect.fn("Bots.recordBotMessage")(function* (
    agentId: string,
    event: BotMessageEvent,
    requestId: string,
  ) {
    const opened = yield* chat(agentId);
    const owner = yield* agent(agentId);

    yield* pi(() =>
      runtime.recordBotMessage(owner, opened.id, event, requestId),
    );
    yield* changed(opened.id);
    yield* forkPreview(agentId, opened.id, agentId);
  });

  return { chat, chatSnapshot, recordBotMessage };
};
