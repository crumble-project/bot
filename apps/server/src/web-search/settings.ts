import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { Secrets } from "../secrets/secrets";
import type { Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import { z } from "zod";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";
import { EXA_KEY } from "./exa";

type Services = Secrets | SettingsRepository;

const DEFAULT_PROVIDER = "web-search:default-provider";

/** The account's default provider; a stored value this server doesn't know reads as Mixed. */
export const defaultProvider = (settings: SettingsRepository["Service"]) =>
  Effect.map(settings.get(DEFAULT_PROVIDER), (stored) =>
    z.enum(WEB_SEARCH_PROVIDER_IDS).catch("mixed").parse(stored),
  );

export function registerWebSearchRoutes(options: {
  register: Register;
  run: Runner<Services>;
}) {
  const { register, run } = options;

  const status = () => ({
    defaultProvider: run.runSync(SettingsRepository.use(defaultProvider)),
    exaKeyConfigured: run.runSync(Secrets.use((s) => s.status(EXA_KEY)))
      .configured,
  });

  register(routes.getWebSearch, (c) => c.json(status(), 200));
  register(routes.updateWebSearch, async (c) => {
    const { defaultProvider } = c.req.valid("json");

    run.runSync(
      SettingsRepository.use((r) => r.set(DEFAULT_PROVIDER, defaultProvider)),
    );

    return c.json(status(), 200);
  });
}
