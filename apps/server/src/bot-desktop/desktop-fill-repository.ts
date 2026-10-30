import { eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import type { Runner } from "../shared/runner";
import { SecretBox } from "../shared/secret-box";
import { nowIso } from "../shared/time";
import type { DesktopFill, DesktopFills } from "./computer-use-login";
import { desktopFills } from "./schema";

/** The passwords typed on each bot desktop, kept until the bot is deleted. */
export class DesktopFillRepository extends Context.Service<
  DesktopFillRepository,
  {
    readonly list: (agentId: string) => Effect.Effect<DesktopFill[]>;
    readonly add: (agentId: string, fill: DesktopFill) => Effect.Effect<void>;
  }
>()("crumble/bot-desktop/DesktopFillRepository") {
  static readonly layer = Layer.effect(
    DesktopFillRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const box = yield* SecretBox;

      const list = Effect.fn("DesktopFillRepository.list")(function* (
        agentId: string,
      ) {
        const rows = yield* db
          .select()
          .from(desktopFills)
          .where(eq(desktopFills.agentId, agentId));

        return rows.map((row) => ({
          value: box.decrypt(row.value),
          label: row.label,
          browser: row.browser,
        }));
      }, Effect.orDie);

      const add = Effect.fn("DesktopFillRepository.add")(function* (
        agentId: string,
        fill: DesktopFill,
      ) {
        yield* db.insert(desktopFills).values({
          agentId,
          value: box.encrypt(fill.value),
          label: fill.label,
          browser: fill.browser,
          filledAt: yield* nowIso,
        });
      }, Effect.orDie);

      return DesktopFillRepository.of({ list, add });
    }),
  );
}

/** One bot desktop's fills, as its computer_use tool reaches them. */
export function desktopFillsAccess(
  runtime: Runner<DesktopFillRepository>,
  agentId: string,
): DesktopFills {
  const repository = runtime.runSync(DesktopFillRepository.use(Effect.succeed));

  return {
    list: () => runtime.runPromise(repository.list(agentId)),
    add: (fill) => runtime.runPromise(repository.add(agentId, fill)),
  };
}
