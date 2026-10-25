import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import type { ControlState } from "./desktop-control";
import { desktopControl } from "./schema";

/** The control lease of each bot desktop. */
export class DesktopControlRepository extends Context.Service<
  DesktopControlRepository,
  {
    /** Null until control first changes. */
    readonly get: (agentId: string) => Effect.Effect<ControlState | null>;
    readonly set: (agentId: string, state: ControlState) => Effect.Effect<void>;
  }
>()("crumble/bot-desktop/DesktopControlRepository") {
  static readonly layer = Layer.effect(
    DesktopControlRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const get = Effect.fn("DesktopControlRepository.get")(function* (
        agentId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(desktopControl)
          .where(eq(desktopControl.agentId, agentId));

        if (!row) return null;

        const state: ControlState = {
          holder: row.holder === "owner" ? "owner" : "bot",
          changes: row.changes,
          updatedAt: row.updatedAt,
        };

        return state;
      }, Effect.orDie);

      const set = Effect.fn("DesktopControlRepository.set")(function* (
        agentId: string,
        state: ControlState,
      ) {
        const row = {
          holder: state.holder,
          changes: state.changes,
          updatedAt: state.updatedAt,
        };

        yield* db
          .insert(desktopControl)
          .values({ agentId, ...row })
          .onConflictDoUpdate({ target: desktopControl.agentId, set: row });
      }, Effect.orDie);

      return DesktopControlRepository.of({ get, set });
    }),
  );
}
