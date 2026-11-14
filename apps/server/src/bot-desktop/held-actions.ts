import type { Context as PiContext } from "@earendil-works/chord";
import { and, desc, eq } from "drizzle-orm";
import { Context, Deferred, Effect, Layer } from "effect";
import { z } from "zod";
import type { OwnerMessage } from "../jobs/owner-request";
import { Conflict, NotFound } from "../shared/errors";
import { ProductDatabase } from "../shared/product-database";
import { HELD_ACTION_STATUSES, OWNER_MESSAGE_SOURCES } from "../shared/domain";
import { keyedListeners } from "../shared/keyed";
import { accessOf, type Access, type Runner } from "../shared/runner";
import { nowIso } from "../shared/time";
import { heldActions } from "./schema";

export type HeldActionStatus = (typeof HELD_ACTION_STATUSES)[number];

export type HeldAction = {
  id: string;
  agentId: string;
  job: string;
  action: string;
  page: string | null;
  ownerMessages: OwnerMessage[];
  reason: string;
  status: HeldActionStatus;
  declineReason: string | null;
  heldAt: string;
  decidedAt: string | null;
};

export type HeldActionSurface = { entryId: string; messageId: string };

export type HoldInput = Pick<
  HeldAction,
  "agentId" | "job" | "action" | "page" | "ownerMessages" | "reason"
>;

export type HoldDecision =
  | { status: "approved" }
  | { status: "declined"; reason: string | null }
  | { status: "expired" };

const LISTED = 50;

const ownerMessage = z.object({
  requestId: z.string(),
  text: z.string(),
  from: z.enum(OWNER_MESSAGE_SOURCES),
});

const statusOf = z.enum(HELD_ACTION_STATUSES).catch("expired");

const heldOf = (row: typeof heldActions.$inferSelect): HeldAction => ({
  id: row.id,
  agentId: row.agentId,
  job: row.job,
  action: row.action,
  page: row.page,
  ownerMessages: z
    .array(ownerMessage)
    .catch([])
    .parse(JSON.parse(row.ownerMessages)),
  reason: row.reason,
  status: statusOf.parse(row.status),
  declineReason: row.declineReason,
  heldAt: row.heldAt,
  decidedAt: row.decidedAt,
});

export class HeldActions extends Context.Service<
  HeldActions,
  {
    readonly hold: (input: HoldInput) => Effect.Effect<HeldAction>;
    readonly list: (agentId: string) => Effect.Effect<HeldAction[]>;
    readonly decide: (
      agentId: string,
      id: string,
      decision: Exclude<HoldDecision, { status: "expired" }>,
    ) => Effect.Effect<HeldAction, NotFound | Conflict>;
    readonly expire: (id: string) => Effect.Effect<void>;
    /** Succeeds with the owner's decision; a decision made earlier is returned at once. */
    readonly untilDecided: (id: string) => Effect.Effect<HoldDecision>;
    readonly cardPosted: (
      action: HeldAction,
      surface: HeldActionSurface,
    ) => Effect.Effect<void>;
    readonly onHeld: (
      listener: (held: HeldAction, surface: HeldActionSurface) => void,
    ) => () => void;
  }
>()("crumble/bot-desktop/HeldActions") {
  static readonly layer = Layer.effect(
    HeldActions,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const listeners = keyedListeners<HoldDecision>();

      const heldListeners = new Set<
        (held: HeldAction, surface: HeldActionSurface) => void
      >();

      // No wait outlives the process: a job's tool call ends with it.
      yield* db
        .update(heldActions)
        .set({ status: "expired", decidedAt: yield* nowIso })
        .where(eq(heldActions.status, "pending"))
        .pipe(Effect.orDie);

      const row = Effect.fnUntraced(function* (id: string) {
        const [found] = yield* db
          .select()
          .from(heldActions)
          .where(eq(heldActions.id, id))
          .pipe(Effect.orDie);

        return found;
      });

      const hold = Effect.fn("HeldActions.hold")(function* (input: HoldInput) {
        const values = {
          ...input,
          id: crypto.randomUUID(),
          ownerMessages: JSON.stringify(input.ownerMessages),
          status: "pending",
          declineReason: null,
          heldAt: yield* nowIso,
          decidedAt: null,
        };

        yield* db.insert(heldActions).values(values).pipe(Effect.orDie);

        return heldOf(values);
      });

      const list = Effect.fn("HeldActions.list")(function* (agentId: string) {
        const rows = yield* db
          .select()
          .from(heldActions)
          .where(eq(heldActions.agentId, agentId))
          .orderBy(desc(heldActions.heldAt))
          .limit(LISTED)
          .pipe(Effect.orDie);

        return rows.map(heldOf);
      });

      const decide = Effect.fn("HeldActions.decide")(function* (
        agentId: string,
        id: string,
        decision: Exclude<HoldDecision, { status: "expired" }>,
      ) {
        const changed = yield* db
          .update(heldActions)
          .set({
            status: decision.status,
            declineReason:
              decision.status === "declined" ? decision.reason : null,
            decidedAt: yield* nowIso,
          })
          .where(
            and(
              eq(heldActions.id, id),
              eq(heldActions.agentId, agentId),
              eq(heldActions.status, "pending"),
            ),
          )
          .returning()
          .pipe(Effect.orDie);

        const [decided] = changed;

        if (decided) {
          listeners.notify(id, decision);

          return heldOf(decided);
        }

        const current = yield* row(id);

        return yield* current?.agentId === agentId
          ? Effect.fail(
              new Conflict({ message: "The action was already decided" }),
            )
          : Effect.fail(new NotFound({ message: "Held action not found" }));
      });

      const expire = Effect.fn("HeldActions.expire")(function* (id: string) {
        const changed = yield* db
          .update(heldActions)
          .set({ status: "expired", decidedAt: yield* nowIso })
          .where(and(eq(heldActions.id, id), eq(heldActions.status, "pending")))
          .returning({ id: heldActions.id })
          .pipe(Effect.orDie);

        if (changed.length) listeners.notify(id, { status: "expired" });
      });

      const decisionOf = (
        current: typeof heldActions.$inferSelect | undefined,
      ): HoldDecision | undefined => {
        if (!current || current.status === "pending") return undefined;

        if (current.status === "approved") return { status: "approved" };

        return current.status === "declined"
          ? { status: "declined", reason: current.declineReason }
          : { status: "expired" };
      };

      const untilDecided = Effect.fn("HeldActions.untilDecided")(function* (
        id: string,
      ) {
        const decided = yield* Deferred.make<HoldDecision>();

        // Listening before reading, so a decision between the two is not missed.
        const stop = Effect.sync(
          listeners.add(id, (decision) =>
            Deferred.doneUnsafe(decided, Effect.succeed(decision)),
          ),
        );

        const earlier = decisionOf(yield* row(id));

        if (earlier) {
          yield* stop;

          return earlier;
        }

        return yield* Deferred.await(decided).pipe(Effect.ensuring(stop));
      });

      const cardPosted = (action: HeldAction, surface: HeldActionSurface) =>
        Effect.sync(() => {
          for (const listener of heldListeners) listener(action, surface);
        });

      const onHeld = (
        listener: (held: HeldAction, surface: HeldActionSurface) => void,
      ) => {
        heldListeners.add(listener);

        return () => void heldListeners.delete(listener);
      };

      return HeldActions.of({
        hold,
        list,
        decide,
        expire,
        untilDecided,
        cardPosted,
        onHeld,
      });
    }),
  );
}

const SYNC_HELD_ACTIONS = ["list"] as const;

export type HeldActionsAccess = Omit<
  Access<HeldActions["Service"], (typeof SYNC_HELD_ACTIONS)[number]>,
  "untilDecided" | "onHeld"
> & {
  /** Resolves with the owner's decision; cancelling `context` expires the action and ends the wait. */
  until(id: string, context: PiContext): Promise<HoldDecision>;
};

export function heldActionsAccess(
  runtime: Runner<HeldActions>,
): HeldActionsAccess {
  const held = runtime.runSync(HeldActions.use(Effect.succeed));

  return {
    ...accessOf(held, runtime, SYNC_HELD_ACTIONS),
    until: async (id, context) => {
      try {
        return await runtime.runPromise(held.untilDecided(id), {
          signal: context.abortSignal,
        });
      } catch (error) {
        await runtime.runPromise(held.expire(id));

        throw error;
      }
    },
  };
}
