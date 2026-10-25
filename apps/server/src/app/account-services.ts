import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { Context, Effect, Layer } from "effect";
import type { AgentRuntime } from "../bots/runtime";
import type { CrumbleService } from "../bots/service";
import { ChartCompiler } from "../display/charts";
import type { GroupChats } from "../group-chats/group-chats";
import type { HistorySearch } from "../history/history-search";
import type { CommonSkill } from "../skills/common-skills";
import type { CoreServices } from "../shared/core-layer";
import { runnerOf } from "../shared/runner";
import { Store } from "../shared/store";
import type { Workspaces } from "../workspaces/workspace";
import type { CrumblePlugin } from "./plugins";

// The account's parts that are not Effect services yet, each provided as the instance it is today. Converting one
// replaces its tag here with the service itself.

/** The product database facade, over the account's own services. */
export class AccountStore extends Context.Service<AccountStore, Store>()(
  "crumble/app/AccountStore",
) {
  static readonly layer = Layer.effect(
    AccountStore,
    Effect.map(
      Effect.context<CoreServices>(),
      (context) => new Store(runnerOf(context)),
    ),
  );
}

/** The account's bot workspaces, or none when the server has no workspace backend. */
export class AccountWorkspaces extends Context.Service<
  AccountWorkspaces,
  Workspaces | undefined
>()("crumble/app/AccountWorkspaces") {
  static layer(make: () => Workspaces | undefined) {
    return Layer.effect(
      AccountWorkspaces,
      Effect.acquireRelease(Effect.sync(make), (workspaces) =>
        Effect.promise(async () => workspaces?.close(BACKGROUND_CONTEXT)),
      ),
    );
  }
}

/** The plugins compiled into the server, as this account configures them. */
export class Plugins extends Context.Service<
  Plugins,
  readonly CrumblePlugin[]
>()("crumble/app/Plugins") {}

/** The QuickJS sandbox of code mode. */
export class Codemode extends Context.Service<Codemode, CodemodeSandbox>()(
  "crumble/app/Codemode",
) {
  static readonly layer = Layer.effect(
    Codemode,
    Effect.acquireRelease(
      Effect.sync(
        () => new CodemodeSandbox({ memoryLimitBytes: 256 * 1024 * 1024 }),
      ),
      (sandbox) => Effect.promise(async () => sandbox.close()),
    ),
  );
}

export class Charts extends Context.Service<Charts, ChartCompiler>()(
  "crumble/app/Charts",
) {
  static readonly layer = Layer.effect(
    Charts,
    Effect.acquireRelease(
      Effect.sync(() => new ChartCompiler()),
      (charts) => Effect.promise(async () => charts.close()),
    ),
  );
}

/** The skills bundled with the server, read-only for every account. */
export class CommonSkills extends Context.Service<
  CommonSkills,
  CommonSkill[]
>()("crumble/app/CommonSkills") {}

export class BotRuntime extends Context.Service<BotRuntime, AgentRuntime>()(
  "crumble/app/BotRuntime",
) {}

export class Bots extends Context.Service<Bots, CrumbleService>()(
  "crumble/app/Bots",
) {}

export class GroupChatsService extends Context.Service<
  GroupChatsService,
  GroupChats
>()("crumble/app/GroupChatsService") {}

export class HistorySearchService extends Context.Service<
  HistorySearchService,
  HistorySearch
>()("crumble/app/HistorySearchService") {}
