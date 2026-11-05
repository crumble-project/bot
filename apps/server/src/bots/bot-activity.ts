import { Context } from "effect";
import type { Activity } from "./bots";

export class BotActivity extends Context.Service<
  BotActivity,
  {
    readonly subscribe: (listener: (event: Activity) => void) => () => void;
  }
>()("crumble/bots/BotActivity") {}
