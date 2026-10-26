import { Effect, Predicate, Semaphore } from "effect";
import type { Conversation } from "../shared/domain";
import type { botsActivity } from "./bots-activity";
import type { botsAnnouncements } from "./bots-announcements";
import { pi, type BotsContext } from "./bots-context";
import type { botsLookup } from "./bots-lookup";
import type { botsReads } from "./bots-reads";
import type { BotMessageEvent } from "./transcript";

/** The bot's one continuous chat, created on first use and stable across restarts. */
const botsChatOpening = (
  context: BotsContext,
  lookup: ReturnType<typeof botsLookup>,
) => {
  const { chatOpenings, conversations, runtime, settings } = context;
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
        const saved = yield* settings.get(`chat:${agentId}`);

        const existing = Predicate.isString(saved)
          ? yield* conversations.get(saved)
          : null;

        const reopen = (found: Conversation) =>
          found.archived
            ? conversations
                .setArchived(found.id, false)
                .pipe(Effect.map((restored) => restored!))
            : Effect.succeed(found);

        if (existing?.agentId === agentId) return yield* reopen(existing);

        // Upgrades from session-based installs continue the most recent session's working context.
        const [legacy] = yield* conversations.list(agentId, true);

        const opened = legacy
          ? yield* reopen(legacy)
          : yield* conversations.create(
              { agentId, title: owner.name },
              yield* pi(() => runtime.openChat(owner)),
            );

        yield* settings.set(`chat:${agentId}`, opened.id);

        return opened;
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
