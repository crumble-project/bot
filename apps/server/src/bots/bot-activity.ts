import { Context } from "effect";
import type { Activity } from "./service";

/** Replies, chat previews, and learned changes as they happen anywhere in the account. */
export class BotActivity extends Context.Service<
  BotActivity,
  {
    /** Calls `listener` for each event until the returned function is called. */
    readonly subscribe: (listener: (event: Activity) => void) => () => void;
  }
>()("crumble/bots/BotActivity") {}
