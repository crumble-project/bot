import { and, desc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Conversation } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { conversations } from "./schema";

export type ConversationPatch = Partial<
  Omit<Conversation, "id" | "createdAt" | "updatedAt">
>;

const conversationOf = (
  row: typeof conversations.$inferSelect,
): Conversation => ({
  id: row.id,
  agentId: row.agentId,
  title: row.title,
  archived: row.archived,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

/** Each bot's conversations: its chat, job conversations, and group working conversations. */
export class ConversationRepository extends Context.Service<
  ConversationRepository,
  {
    /** Most recently updated first; archived ones only when asked for. */
    readonly list: (
      agentId?: string,
      includeArchived?: boolean,
    ) => Effect.Effect<Conversation[]>;
    readonly get: (
      conversationId: string,
    ) => Effect.Effect<Conversation | null>;
    readonly create: (
      input: { agentId: string; title: string },
      conversationId?: string,
    ) => Effect.Effect<Conversation>;
    readonly update: (
      conversationId: string,
      patch: ConversationPatch,
    ) => Effect.Effect<Conversation | null>;
    readonly setArchived: (
      conversationId: string,
      archived: boolean,
    ) => Effect.Effect<Conversation | null>;
    readonly delete: (conversationId: string) => Effect.Effect<boolean>;
  }
>()("crumble/bots/ConversationRepository") {
  static readonly layer = Layer.effect(
    ConversationRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const list = Effect.fn("ConversationRepository.list")(function* (
        agentId: string | undefined,
        includeArchived: boolean,
      ) {
        const rows = yield* db
          .select()
          .from(conversations)
          .where(
            and(
              agentId ? eq(conversations.agentId, agentId) : undefined,
              includeArchived ? undefined : eq(conversations.archived, false),
            ),
          )
          .orderBy(desc(conversations.updatedAt));

        return rows.map(conversationOf);
      }, Effect.orDie);

      const get = Effect.fn("ConversationRepository.get")(function* (
        conversationId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(conversations)
          .where(eq(conversations.id, conversationId));

        return row ? conversationOf(row) : null;
      }, Effect.orDie);

      const create = Effect.fn("ConversationRepository.create")(function* (
        input: { agentId: string; title: string },
        conversationId: string = crypto.randomUUID(),
      ) {
        const at = yield* nowIso;

        yield* db.insert(conversations).values({
          id: conversationId,
          agentId: input.agentId,
          title: input.title,
          archived: false,
          createdAt: at,
          updatedAt: at,
        });

        return (yield* get(conversationId))!;
      }, Effect.orDie);

      const update = Effect.fn("ConversationRepository.update")(function* (
        conversationId: string,
        patch: ConversationPatch,
      ) {
        const conversation = yield* get(conversationId);

        if (!conversation) return null;

        yield* db
          .update(conversations)
          .set({
            title: patch.title ?? conversation.title,
            archived: patch.archived ?? conversation.archived ?? false,
            updatedAt: yield* nowIso,
          })
          .where(eq(conversations.id, conversationId));

        return yield* get(conversationId);
      }, Effect.orDie);

      const setArchived = Effect.fn("ConversationRepository.setArchived")(
        function* (conversationId: string, archived: boolean) {
          if (!(yield* get(conversationId))) return null;

          yield* db
            .update(conversations)
            .set({ archived, updatedAt: yield* nowIso })
            .where(eq(conversations.id, conversationId));

          return yield* get(conversationId);
        },
        Effect.orDie,
      );

      const remove = Effect.fn("ConversationRepository.delete")(function* (
        conversationId: string,
      ) {
        const deleted = yield* db
          .delete(conversations)
          .where(eq(conversations.id, conversationId))
          .returning({ id: conversations.id });

        return deleted.length > 0;
      }, Effect.orDie);

      return ConversationRepository.of({
        list: (agentId, includeArchived = false) =>
          list(agentId, includeArchived),
        get,
        create,
        update,
        setArchived,
        delete: remove,
      });
    }),
  );
}
