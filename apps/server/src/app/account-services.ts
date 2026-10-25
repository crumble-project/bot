import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Context, Effect, Layer } from "effect";
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
