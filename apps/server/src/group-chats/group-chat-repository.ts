import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import type {
  GroupChat,
  GroupChatInput,
  GroupMember,
  GroupTurn,
  GroupTurnStatus,
} from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { groupChats, groupMembers, groupTurns } from "./schema";

/** Owner messages, by entry number, whose first bot answer has not notified, with the bots they woke. */
const awaitingAnswers = z.record(z.string(), z.array(z.string()));

export type GroupActivity = {
  botTurns: number;
  paused: boolean;
  /** Owner messages, by entry number, whose first bot answer has not notified yet, with the bots they woke. */
  awaitingAnswers: Record<string, string[]>;
};

export type GroupMemberChange = Partial<
  Pick<
    GroupMember,
    "conversationId" | "cursor" | "pending" | "pendingBotStarted" | "summary"
  >
>;

const turnOf = (row: typeof groupTurns.$inferSelect): GroupTurn => ({
  executionId: row.executionId,
  groupId: row.groupId,
  agentId: row.agentId,
  through: row.through,
  botStarted: row.botStarted,
  status: row.status,
  createdAt: row.createdAt,
});

/** Group chats, their members' progress through the shared transcript, and their turns. */
export class GroupChatRepository extends Context.Service<
  GroupChatRepository,
  {
    /** Oldest first. */
    readonly list: Effect.Effect<GroupChat[]>;
    readonly get: (groupId: string) => Effect.Effect<GroupChat | null>;
    readonly create: (
      input: GroupChatInput,
      groupId?: string,
    ) => Effect.Effect<GroupChat>;
    /** Replaces name and members; members that stay keep their place in the join order. */
    readonly update: (
      groupId: string,
      input: GroupChatInput,
    ) => Effect.Effect<GroupChat | null>;
    readonly delete: (groupId: string) => Effect.Effect<boolean>;
    readonly member: (
      groupId: string,
      agentId: string,
    ) => Effect.Effect<GroupMember | undefined>;
    readonly setMember: (
      groupId: string,
      agentId: string,
      change: GroupMemberChange,
    ) => Effect.Effect<void>;
    readonly activity: (groupId: string) => Effect.Effect<GroupActivity>;
    readonly setActivity: (
      groupId: string,
      change: Partial<GroupActivity>,
    ) => Effect.Effect<void>;
    readonly createTurn: (
      turn: Omit<GroupTurn, "createdAt">,
    ) => Effect.Effect<GroupTurn>;
    readonly getTurn: (
      executionId: string,
    ) => Effect.Effect<GroupTurn | undefined>;
    readonly updateTurn: (
      executionId: string,
      change: { status: GroupTurnStatus },
    ) => Effect.Effect<void>;
    /** The member's unsettled turn in the group; there is at most one. */
    readonly activeTurn: (
      groupId: string,
      agentId: string,
    ) => Effect.Effect<GroupTurn | undefined>;
    /** Oldest first, optionally in one group or with some statuses. */
    readonly listTurns: (filter?: {
      groupId?: string;
      status?: GroupTurnStatus[];
    }) => Effect.Effect<GroupTurn[]>;
  }
>()("crumble/group-chats/GroupChatRepository") {
  static readonly layer = Layer.effect(
    GroupChatRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const groupOf = Effect.fnUntraced(function* (
        row: typeof groupChats.$inferSelect,
      ) {
        const members = yield* db
          .select({ agentId: groupMembers.agentId })
          .from(groupMembers)
          .where(eq(groupMembers.groupId, row.id))
          .orderBy(asc(groupMembers.joinedAt), sql`rowid`);

        const group: GroupChat = {
          id: row.id,
          name: row.name,
          memberIds: members.map((member) => member.agentId),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };

        return group;
      });

      const list = Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(groupChats)
          .orderBy(asc(groupChats.createdAt), sql`rowid`);

        return yield* Effect.forEach(rows, groupOf);
      }).pipe(Effect.orDie, Effect.withSpan("GroupChatRepository.list"));

      const get = Effect.fn("GroupChatRepository.get")(function* (
        groupId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(groupChats)
          .where(eq(groupChats.id, groupId));

        return row ? yield* groupOf(row) : null;
      }, Effect.orDie);

      const insertMembers = Effect.fnUntraced(function* (
        groupId: string,
        agentIds: ReadonlyArray<string>,
        joinedAt: string,
      ) {
        if (agentIds.length)
          yield* db
            .insert(groupMembers)
            .values(
              agentIds.map((agentId) => ({ groupId, agentId, joinedAt })),
            );
      });

      const create = Effect.fn("GroupChatRepository.create")(function* (
        input: GroupChatInput,
        groupId: string = crypto.randomUUID(),
      ) {
        const at = yield* nowIso;

        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db.insert(groupChats).values({
              id: groupId,
              name: input.name,
              createdAt: at,
              updatedAt: at,
            });
            yield* insertMembers(groupId, input.memberIds, at);
          }),
        );

        return (yield* get(groupId))!;
      }, Effect.orDie);

      const update = Effect.fn("GroupChatRepository.update")(function* (
        groupId: string,
        input: GroupChatInput,
      ) {
        const current = yield* get(groupId);

        if (!current) return null;
        const at = yield* nowIso;
        const kept = new Set(input.memberIds);

        yield* db.transaction(() =>
          Effect.gen(function* () {
            yield* db
              .update(groupChats)
              .set({ name: input.name, updatedAt: at })
              .where(eq(groupChats.id, groupId));

            for (const agentId of current.memberIds)
              if (!kept.has(agentId))
                yield* db
                  .delete(groupMembers)
                  .where(
                    and(
                      eq(groupMembers.groupId, groupId),
                      eq(groupMembers.agentId, agentId),
                    ),
                  );

            yield* insertMembers(
              groupId,
              input.memberIds.filter(
                (agentId) => !current.memberIds.includes(agentId),
              ),
              at,
            );
          }),
        );

        return yield* get(groupId);
      }, Effect.orDie);

      const remove = Effect.fn("GroupChatRepository.delete")(function* (
        groupId: string,
      ) {
        const deleted = yield* db
          .delete(groupChats)
          .where(eq(groupChats.id, groupId))
          .returning({ id: groupChats.id });

        return deleted.length > 0;
      }, Effect.orDie);

      const membership = (groupId: string, agentId: string) =>
        and(
          eq(groupMembers.groupId, groupId),
          eq(groupMembers.agentId, agentId),
        );

      const member = Effect.fn("GroupChatRepository.member")(function* (
        groupId: string,
        agentId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(groupMembers)
          .where(membership(groupId, agentId));

        if (!row) return undefined;

        const state: GroupMember = {
          groupId: row.groupId,
          agentId: row.agentId,
          conversationId: row.conversationId,
          cursor: row.cursor,
          pending: row.pending,
          pendingBotStarted: row.pendingBotStarted,
          summary: row.summary,
          joinedAt: row.joinedAt,
        };

        return state;
      }, Effect.orDie);

      const setMember = Effect.fn("GroupChatRepository.setMember")(function* (
        groupId: string,
        agentId: string,
        change: GroupMemberChange,
      ) {
        const current = yield* member(groupId, agentId);

        if (!current) return;
        const next = { ...current, ...change };

        yield* db
          .update(groupMembers)
          .set({
            conversationId: next.conversationId,
            cursor: next.cursor,
            pending: next.pending,
            pendingBotStarted: next.pendingBotStarted,
            summary: next.summary,
          })
          .where(membership(groupId, agentId));
      }, Effect.orDie);

      const activity = Effect.fn("GroupChatRepository.activity")(function* (
        groupId: string,
      ) {
        const [row] = yield* db
          .select({
            botTurns: groupChats.botTurns,
            paused: groupChats.paused,
            awaitingAnswers: groupChats.awaitingAnswers,
          })
          .from(groupChats)
          .where(eq(groupChats.id, groupId));

        const state: GroupActivity = {
          botTurns: row?.botTurns ?? 0,
          paused: row?.paused ?? false,
          awaitingAnswers:
            awaitingAnswers.safeParse(JSON.parse(row?.awaitingAnswers ?? "{}"))
              .data ?? {},
        };

        return state;
      }, Effect.orDie);

      const setActivity = Effect.fn("GroupChatRepository.setActivity")(
        function* (groupId: string, change: Partial<GroupActivity>) {
          const next = { ...(yield* activity(groupId)), ...change };

          yield* db
            .update(groupChats)
            .set({
              botTurns: next.botTurns,
              paused: next.paused,
              awaitingAnswers: JSON.stringify(next.awaitingAnswers),
            })
            .where(eq(groupChats.id, groupId));
        },
        Effect.orDie,
      );

      const getTurn = Effect.fn("GroupChatRepository.getTurn")(function* (
        executionId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(groupTurns)
          .where(eq(groupTurns.executionId, executionId));

        return row ? turnOf(row) : undefined;
      }, Effect.orDie);

      const createTurn = Effect.fn("GroupChatRepository.createTurn")(function* (
        turn: Omit<GroupTurn, "createdAt">,
      ) {
        yield* db.insert(groupTurns).values({
          executionId: turn.executionId,
          groupId: turn.groupId,
          agentId: turn.agentId,
          through: turn.through,
          botStarted: turn.botStarted,
          status: turn.status,
          createdAt: yield* nowIso,
        });

        return (yield* getTurn(turn.executionId))!;
      }, Effect.orDie);

      const updateTurn = Effect.fn("GroupChatRepository.updateTurn")(function* (
        executionId: string,
        change: { status: GroupTurnStatus },
      ) {
        yield* db
          .update(groupTurns)
          .set({ status: change.status })
          .where(eq(groupTurns.executionId, executionId));
      }, Effect.orDie);

      const activeTurn = Effect.fn("GroupChatRepository.activeTurn")(function* (
        groupId: string,
        agentId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(groupTurns)
          .where(
            and(
              eq(groupTurns.groupId, groupId),
              eq(groupTurns.agentId, agentId),
              ne(groupTurns.status, "settled"),
            ),
          )
          .orderBy(desc(groupTurns.createdAt), sql`rowid DESC`)
          .limit(1);

        return row ? turnOf(row) : undefined;
      }, Effect.orDie);

      const listTurns = Effect.fn("GroupChatRepository.listTurns")(
        function* (filter: { groupId?: string; status?: GroupTurnStatus[] }) {
          const rows = yield* db
            .select()
            .from(groupTurns)
            .orderBy(asc(groupTurns.createdAt), sql`rowid`);

          return rows
            .map(turnOf)
            .filter(
              (turn) =>
                (!filter.groupId || turn.groupId === filter.groupId) &&
                (!filter.status || filter.status.includes(turn.status)),
            );
        },
        Effect.orDie,
      );

      return GroupChatRepository.of({
        list,
        get,
        create,
        update,
        delete: remove,
        member,
        setMember,
        activity,
        setActivity,
        createTurn,
        getTurn,
        updateTurn,
        activeTurn,
        listTurns: (filter = {}) => listTurns(filter),
      });
    }),
  );
}
