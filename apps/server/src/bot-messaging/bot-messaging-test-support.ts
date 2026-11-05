import { Effect } from "effect";
import type { AgentRepository } from "../bot-store/agent-repository";
import type { Bots } from "../bots/bots";
import type { ExecutionRepository } from "../bot-store/execution-repository";
import type { BotRuntime } from "../bots/runtime";
import type { ProductDatabase } from "../shared/product-database";
import type { Runner } from "../shared/runner";
import { BotMessaging } from "./bot-messaging";

export const standaloneMessaging = (bots: {
  effects: Runner<
    Bots | BotRuntime | AgentRepository | ExecutionRepository | ProductDatabase
  >;
}) =>
  bots.effects.runSync(
    BotMessaging.use(Effect.succeed).pipe(Effect.provide(BotMessaging.layer)),
  );
