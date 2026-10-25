import { Context, Effect, Layer } from "effect";
import type { CoreServices } from "../shared/core-layer";
import { runnerOf } from "../shared/runner";
import { Store } from "../shared/store";

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
