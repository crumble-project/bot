import { Effect, Layer, ManagedRuntime } from "effect";
import type { Runner } from "../shared/runner";
import type { SettingsRepository } from "../shared/settings-repository";
import type { ProviderContribution } from "../plugins/plugins";
import { ProviderSignIns, type ProviderSignInsAccess } from "./provider-auth";
import type { ProviderCredentials } from "./provider-credentials";
import { ProviderModels, hostModels } from "./providers";

type StandaloneSignInServices = ProviderCredentials | SettingsRepository;

/** Sign-ins over the credentials and settings `core` reaches, for an API that runs without an account. */
export function standaloneSignIns(
  core: Runner<StandaloneSignInServices>,
  contributions: readonly ProviderContribution[],
): ProviderSignInsAccess {
  const context = core.runSync(Effect.context<StandaloneSignInServices>());

  return ManagedRuntime.make(
    ProviderSignIns.layer.pipe(
      Layer.provide(ProviderModels.layer(hostModels, contributions)),
      Layer.provide(Layer.succeedContext(context)),
    ),
  ).runSync(ProviderSignIns.use(Effect.succeed));
}
