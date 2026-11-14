import { and, eq, inArray, lt } from "drizzle-orm";
import { Clock, Context, Effect, Layer } from "effect";
import { AgentRepository } from "../bot-store/agent-repository";
import type {
  ChatReference,
  ReplyAssociation,
  ReplyReference,
} from "../contract/push";
import { replySurface } from "../contract/push";
import { replyEvent } from "../contract/reply-event";
import { GroupChatRepository } from "../group-chats/group-chat-repository";
import { Conflict, NotFound } from "../shared/errors";
import { PushDatabase } from "./push-database";
import { chatViews, pushOutbox, replyAssociations } from "./schema";

const TTL = 120_000;
const missing = () => new NotFound({ message: "Chat or reply not found" });

export class ChatAttention extends Context.Service<
  ChatAttention,
  {
    readonly exists: (chat: ChatReference) => Effect.Effect<boolean>;
    readonly view: (
      viewId: string,
      chat: ChatReference | null,
    ) => Effect.Effect<void, NotFound>;
    readonly seen: (
      chat: ChatReference,
      eventIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, NotFound>;
    readonly register: (
      association: ReplyAssociation,
    ) => Effect.Effect<void, NotFound | Conflict>;
    readonly references: (
      chat: ChatReference,
      messageIds: ReadonlyArray<string>,
    ) => Effect.Effect<
      ReadonlyMap<string, ReadonlyArray<ReplyReference>>,
      NotFound
    >;
    readonly isSuppressed: (
      chat: ChatReference,
      eventId: string,
    ) => Effect.Effect<boolean, NotFound>;
    readonly removeChat: (chat: ChatReference) => Effect.Effect<void>;
    readonly cleanup: Effect.Effect<void>;
  }
>()("crumble/push/ChatAttention") {
  static readonly layer = Layer.effect(
    ChatAttention,
    Effect.gen(function* () {
      const db = yield* PushDatabase;
      const agents = yield* AgentRepository;
      const groups = yield* GroupChatRepository;

      const exists = Effect.fn("ChatAttention.exists")(function* (
        chat: ChatReference,
      ) {
        return !!(yield* chat.kind === "bot"
          ? agents.get(chat.id)
          : groups.get(chat.id));
      });

      const requireChat = Effect.fnUntraced(function* (chat: ChatReference) {
        if (!(yield* exists(chat))) return yield* missing();
      });

      const view = Effect.fn("ChatAttention.view")(function* (
        viewId: string,
        chat: ChatReference | null,
      ) {
        if (chat) yield* requireChat(chat);

        if (!chat) {
          yield* db
            .delete(chatViews)
            .where(eq(chatViews.viewId, viewId))
            .pipe(Effect.orDie);

          return;
        }

        const values = {
          chatKind: chat.kind,
          chatId: chat.id,
          refreshedAt: yield* Clock.currentTimeMillis,
        };

        yield* db
          .insert(chatViews)
          .values({ viewId, ...values })
          .onConflictDoUpdate({ target: chatViews.viewId, set: values })
          .pipe(Effect.orDie);
      });

      const seen = Effect.fn("ChatAttention.seen")(function* (
        chat: ChatReference,
        eventIds: ReadonlyArray<string>,
      ) {
        yield* requireChat(chat);

        if (!eventIds.length) return;

        const valid = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              const rows = yield* tx
                .select({ eventId: replyAssociations.eventId })
                .from(replyAssociations)
                .where(
                  and(
                    eq(replyAssociations.chatKind, chat.kind),
                    eq(replyAssociations.chatId, chat.id),
                    inArray(replyAssociations.eventId, [...eventIds]),
                  ),
                );

              if (rows.length !== new Set(eventIds).size) return false;
              yield* tx
                .update(replyAssociations)
                .set({ seen: true })
                .where(inArray(replyAssociations.eventId, [...eventIds]));

              return true;
            }),
          )
          .pipe(Effect.orDie);

        if (!valid) return yield* missing();
      });

      const register = Effect.fn("ChatAttention.register")(function* (
        association: ReplyAssociation,
      ) {
        yield* requireChat(association.chat);

        const values = {
          eventId: association.eventId,
          chatKind: association.chat.kind,
          chatId: association.chat.id,
          messageId: association.messageId,
          entryId: association.entryId,
          surfaceJson: JSON.stringify(replySurface.parse(association.surface)),
        };

        const matching = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .insert(replyAssociations)
                .values(values)
                .onConflictDoNothing();

              const [row] = yield* tx
                .select()
                .from(replyAssociations)
                .where(eq(replyAssociations.eventId, values.eventId));

              return (
                !!row &&
                row.chatKind === values.chatKind &&
                row.chatId === values.chatId &&
                row.messageId === values.messageId &&
                row.entryId === values.entryId &&
                row.surfaceJson === values.surfaceJson
              );
            }),
          )
          .pipe(Effect.orDie);

        if (!matching)
          return yield* new Conflict({
            message: "Reply association already exists",
          });
      });

      const references = Effect.fn("ChatAttention.references")(function* (
        chat: ChatReference,
        messageIds: ReadonlyArray<string>,
      ) {
        yield* requireChat(chat);
        const result = new Map<string, ReplyReference[]>();

        if (!messageIds.length) return result;

        const rows = yield* db
          .select()
          .from(replyAssociations)
          .where(
            and(
              eq(replyAssociations.chatKind, chat.kind),
              eq(replyAssociations.chatId, chat.id),
              inArray(replyAssociations.messageId, [...messageIds]),
            ),
          )
          .pipe(Effect.orDie);

        for (const row of rows) {
          const refs = result.get(row.messageId) ?? [];
          refs.push({
            eventId: row.eventId,
            surface: replySurface.parse(JSON.parse(row.surfaceJson)),
          });
          result.set(row.messageId, refs);
        }

        return result;
      });

      const isSuppressed = Effect.fn("ChatAttention.isSuppressed")(function* (
        chat: ChatReference,
        eventId: string,
      ) {
        yield* requireChat(chat);

        const [association] = yield* db
          .select()
          .from(replyAssociations)
          .where(
            and(
              eq(replyAssociations.eventId, eventId),
              eq(replyAssociations.chatKind, chat.kind),
              eq(replyAssociations.chatId, chat.id),
            ),
          )
          .pipe(Effect.orDie);

        if (association?.seen) return true;
        const now = yield* Clock.currentTimeMillis;

        const views = yield* db
          .select()
          .from(chatViews)
          .where(
            and(
              eq(chatViews.chatKind, chat.kind),
              eq(chatViews.chatId, chat.id),
            ),
          )
          .pipe(Effect.orDie);

        return views.some((view) => now - view.refreshedAt <= TTL);
      });

      const removeChat = Effect.fn("ChatAttention.removeChat")(function* (
        chat: ChatReference,
      ) {
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(chatViews)
                .where(
                  and(
                    eq(chatViews.chatKind, chat.kind),
                    eq(chatViews.chatId, chat.id),
                  ),
                );
              yield* tx
                .delete(replyAssociations)
                .where(
                  and(
                    eq(replyAssociations.chatKind, chat.kind),
                    eq(replyAssociations.chatId, chat.id),
                  ),
                );
              const rows = yield* tx.select().from(pushOutbox);

              for (const row of rows) {
                const event = replyEvent.parse(JSON.parse(row.eventJson));

                if (
                  event.groupId
                    ? chat.kind === "group" && event.groupId === chat.id
                    : chat.kind === "bot" && event.agentId === chat.id
                )
                  yield* tx.delete(pushOutbox).where(eq(pushOutbox.id, row.id));
              }
            }),
          )
          .pipe(Effect.orDie);
      });

      const cleanup = Effect.gen(function* () {
        yield* db
          .delete(chatViews)
          .where(
            lt(chatViews.refreshedAt, (yield* Clock.currentTimeMillis) - TTL),
          )
          .pipe(Effect.orDie);
        const views = yield* db.select().from(chatViews).pipe(Effect.orDie);

        const associations = yield* db
          .select()
          .from(replyAssociations)
          .pipe(Effect.orDie);

        const chats = new Map<string, ChatReference>();

        for (const row of [...views, ...associations])
          chats.set(`${row.chatKind}:${row.chatId}`, {
            kind: row.chatKind,
            id: row.chatId,
          });
        const outbox = yield* db.select().from(pushOutbox).pipe(Effect.orDie);

        for (const row of outbox) {
          const event = replyEvent.parse(JSON.parse(row.eventJson));

          const chat: ChatReference = event.groupId
            ? { kind: "group", id: event.groupId }
            : { kind: "bot", id: event.agentId };

          chats.set(`${chat.kind}:${chat.id}`, chat);
        }

        for (const chat of chats.values())
          if (!(yield* exists(chat))) yield* removeChat(chat);
      });

      return ChatAttention.of({
        exists,
        view,
        seen,
        register,
        references,
        isSuppressed,
        removeChat,
        cleanup,
      });
    }),
  );
}
