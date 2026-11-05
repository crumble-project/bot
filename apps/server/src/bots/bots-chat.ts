import { pi } from "../shared/app-errors";
import { Effect, Semaphore } from "effect";
import type { botsActivity } from "./bots-activity";
import type { botsAnnouncements } from "./bots-announcements";
import { type BotsContext } from "./bots-context";
import type { botsLookup } from "./bots-lookup";
import type { botsReads } from "./bots-reads";
import type { BotMessageEvent } from "./transcript";

/** The bot's one continuous chat, created on first use and stable across restarts. */
const botsChatOpening = (
  context: BotsContext,
  lookup: ReturnType<typeof botsLookup>,
) => {
  const { chatOpenings, conversations, runtime } = context;
  const { agent } = lookup;

  const chat = Effect.fn("Bots.chat")(function* (agentId: string) {
    let lock = chatOpenings.get(agentId);

    if (!lock) {
      lock = Semaphore.makeUnsafe(1);
      chatOpenings.set(agentId, lock);
    }

    return yield* Semaphore.withPermit(
      lock,
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

  return { chat };
};

/** The reads and writes a bot's chat offers once it exists, such as its snapshot and bot-written messages. */
const botsChatRecords = (
  context: BotsContext,
  deps: ChatDeps,
  chat: ReturnType<typeof botsChatOpening>["chat"],
) => {
  const { runtime } = context;
  const { agent } = deps.lookup;
  const { changed } = deps.notifications;
  const { snapshot } = deps.reads;
  const { forkPreview } = deps.announcements;

  const chatSnapshot = (
    agentId: string,
    options: { limit?: number | undefined } = {},
  ) =>
    chat(agentId).pipe(
      Effect.flatMap((opened) => snapshot(opened.id, options)),
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

  return { chatSnapshot, recordBotMessage };
};

type ChatDeps = {
  lookup: ReturnType<typeof botsLookup>;
  reads: ReturnType<typeof botsReads>;
  notifications: ReturnType<typeof botsActivity>;
  announcements: ReturnType<typeof botsAnnouncements>;
};

/** The bot's chat: opening it once, then reading it and writing bot messages into it. */
export const botsChat = (context: BotsContext, deps: ChatDeps) => {
  const { chat } = botsChatOpening(context, deps.lookup);

  return { chat, ...botsChatRecords(context, deps, chat) };
};
