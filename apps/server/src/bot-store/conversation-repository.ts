import { and, desc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { conversations } from "./schema";

export type Conversation = {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  archived?: boolean;
};

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
    readonly chatOf: (agentId: string) => Effect.Effect<Conversation | null>;
    readonly create: (
      input: { agentId: string; title: string; chat?: boolean },
      conversationId?: string,
    ) => Effect.Effect<Conversation>;
    readonly setArchived: (
      conversationId: string,
      archived: boolean,
    ) => Effect.Effect<Conversation | null>;
  }
>()("crumble/bot-store/ConversationRepository") {
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

      const chatOf = Effect.fn("ConversationRepository.chatOf")(function* (
        agentId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(conversations)
          .where(
            and(
              eq(conversations.agentId, agentId),
              eq(conversations.chat, true),
            ),
          );

        return row ? conversationOf(row) : null;
      }, Effect.orDie);

      const create = Effect.fn("ConversationRepository.create")(function* (
        input: { agentId: string; title: string; chat?: boolean },
        conversationId: string = crypto.randomUUID(),
      ) {
        const at = yield* nowIso;

        yield* db.insert(conversations).values({
          id: conversationId,
          agentId: input.agentId,
          title: input.title,
          archived: false,
          chat: input.chat ?? false,
          createdAt: at,
          updatedAt: at,
        });

        return (yield* get(conversationId))!;
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

      return ConversationRepository.of({
        list: (agentId, includeArchived = false) =>
          list(agentId, includeArchived),
        get,
        chatOf,
        create,
        setArchived,
      });
    }),
  );
}
