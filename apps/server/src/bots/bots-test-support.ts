import { Effect, Layer, ManagedRuntime } from "effect";
import type { EventRepository } from "../event-sources/event-repository";
import type { ScheduleRepository } from "../automations/schedule-repository";
import type { ProductDatabase } from "../shared/product-database";
import type { Runner } from "../shared/runner";
import type { SettingsRepository } from "../shared/settings-repository";
import type { AgentRepository } from "../bot-store/agent-repository";
import { Bots, botsAccess, type BotsAccess } from "./bots";
import type { BotDeletion } from "../bot-ports/bot-deletion";
import type { BotNotices } from "../bot-ports/bot-notices";
import type { ConversationRepository } from "../bot-store/conversation-repository";
import type { ExecutionRepository } from "../bot-store/execution-repository";
import { BotRuntime, type AgentRuntime } from "./runtime";

type StandaloneServices =
  | Bots
  | BotRuntime
  | AgentRepository
  | ConversationRepository
  | ExecutionRepository
  | SettingsRepository
  | ScheduleRepository
  | EventRepository
  | BotNotices
  | BotDeletion
  | ProductDatabase;

type StoreServices = Exclude<StandaloneServices, Bots | BotRuntime>;

/**
 * The bots over `store`'s account and `runtime`, for a test without an account. Closing them stops the bots, then
 * closes the runtime and the store.
 */
export function standaloneBots<
  S extends { runtime: Runner<StoreServices>; close(): void },
>(
  store: S,
  runtime: AgentRuntime,
): BotsAccess & {
  store: S;
  /** The store's account, for code that reads its repositories. */
  core: S["runtime"];
  runtime: AgentRuntime;
  /** Runs effects over the bots and what they stand on, such as features built on the bots in a test. */
  effects: Runner<StandaloneServices>;
  close(): Promise<void>;
} {
  const bots = ManagedRuntime.make(
    Bots.layer.pipe(
      Layer.provideMerge(Layer.succeed(BotRuntime, runtime)),
      Layer.provideMerge(
        Layer.succeedContext(
          store.runtime.runSync(Effect.context<StoreServices>()),
        ),
      ),
    ),
  );

  return {
    ...botsAccess(bots),
    store,
    core: store.runtime,
    runtime,
    effects: bots,
    close: async () => {
      await bots.dispose();
      await runtime.close();
      store.close();
    },
  };
}
