import type { Context as PiContext } from "@earendil-works/chord";
import { and, desc, eq } from "drizzle-orm";
import { Context, Deferred, Effect, Layer } from "effect";
import { z } from "zod";
import type { OwnerMessage } from "../jobs/owner-request";
import { Conflict, NotFound } from "../shared/errors";
import { ProductDatabase } from "../shared/product-database";
import type { Runner } from "../shared/runner";
import { nowIso } from "../shared/time";
import { heldActions } from "./schema";

export type HeldActionStatus = "pending" | "approved" | "declined" | "expired";

/** A desktop job's action an intent check held, waiting for the owner or decided. */
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

export type HoldInput = Pick<
  HeldAction,
  "agentId" | "job" | "action" | "page" | "ownerMessages" | "reason"
>;

/** The owner's answer; a wait that ended without one, such as a stopped job, is `expired`. */
export type HoldDecision =
  | { status: "approved" }
  | { status: "declined"; reason: string | null }
  | { status: "expired" };

type Listener = (decision: HoldDecision) => void;

const LISTED = 50;

const ownerMessage = z.object({
  requestId: z.string(),
  text: z.string(),
  from: z.enum(["owner", "automation"]),
});

const statusOf = z
  .enum(["pending", "approved", "declined", "expired"])
  .catch("expired");

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

/** Held actions: durable in the database, with a wait that ends at the owner's decision. */
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
    /** Marks a pending action expired, such as when its job stopped waiting. */
    readonly expire: (id: string) => Effect.Effect<void>;
    /** Succeeds with the owner's decision; a decision made earlier is returned at once. */
    readonly untilDecided: (id: string) => Effect.Effect<HoldDecision>;
    /** Calls `listener` with each newly held action, until the returned function is called. */
    readonly onHeld: (listener: (held: HeldAction) => void) => () => void;
  }
>()("crumble/bot-desktop/HeldActions") {
  static readonly layer = Layer.effect(
    HeldActions,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const listeners = new Map<string, Set<Listener>>();
      const heldListeners = new Set<(held: HeldAction) => void>();

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

      const announce = (id: string, decision: HoldDecision) => {
        for (const listener of listeners.get(id) ?? []) listener(decision);
      };

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

        const held = heldOf(values);

        for (const listener of heldListeners) listener(held);

        return held;
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
          announce(id, decision);

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

        if (changed.length) announce(id, { status: "expired" });
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
        const set = listeners.get(id) ?? new Set<Listener>();

        // Listening before reading, so a decision between the two is not missed.
        const listener: Listener = (decision) =>
          Deferred.doneUnsafe(decided, Effect.succeed(decision));

        set.add(listener);
        listeners.set(id, set);

        const stop = Effect.sync(() => {
          set.delete(listener);

          if (!set.size) listeners.delete(id);
        });

        const earlier = decisionOf(yield* row(id));

        if (earlier) {
          yield* stop;

          return earlier;
        }

        return yield* Deferred.await(decided).pipe(Effect.ensuring(stop));
      });

      const onHeld = (listener: (held: HeldAction) => void) => {
        heldListeners.add(listener);

        return () => void heldListeners.delete(listener);
      };

      return HeldActions.of({
        hold,
        list,
        decide,
        expire,
        untilDecided,
        onHeld,
      });
    }),
  );
}

/** Held actions for HTTP handlers and a desktop job's tool, outside Effect. */
export type HeldActionsAccess = {
  list(agentId: string): HeldAction[];
  decide(
    agentId: string,
    id: string,
    decision: Exclude<HoldDecision, { status: "expired" }>,
  ): Promise<HeldAction>;
  hold(input: HoldInput): Promise<HeldAction>;
  /** Resolves with the owner's decision; cancelling `context` expires the action and ends the wait. */
  until(id: string, context: PiContext): Promise<HoldDecision>;
};

export function heldActionsAccess(
  runtime: Runner<HeldActions>,
): HeldActionsAccess {
  const held = runtime.runSync(HeldActions.use(Effect.succeed));

  return {
    list: (agentId) => runtime.runSync(held.list(agentId)),
    decide: (agentId, id, decision) =>
      runtime.runPromise(held.decide(agentId, id, decision)),
    hold: (input) => runtime.runPromise(held.hold(input)),
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
