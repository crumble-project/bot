import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { Secrets } from "../password-managers/secrets";
import type { Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import { z } from "zod";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";
import { EXA_KEY } from "./exa";

type Services = Secrets | SettingsRepository;

export const DEFAULT_PROVIDER = "web-search:default-provider";

export function registerWebSearchRoutes(options: {
  register: Register;
  run: Runner<Services>;
}) {
  const { register, run } = options;

  const status = () => ({
    defaultProvider: z
      .enum(WEB_SEARCH_PROVIDER_IDS)
      .catch("mixed")
      .parse(
        run.runSync(SettingsRepository.use((r) => r.get(DEFAULT_PROVIDER))),
      ),
    exaKeyConfigured: run.runSync(Secrets.use((s) => s.status(EXA_KEY)))
      .configured,
  });

  register(routes.getWebSearch, (c) => c.json(status(), 200));
  register(routes.updateWebSearch, async (c) => {
    const input = z
      .object({ defaultProvider: z.enum(WEB_SEARCH_PROVIDER_IDS) })
      .parse(await c.req.json());

    run.runSync(
      SettingsRepository.use((r) =>
        r.set(DEFAULT_PROVIDER, input.defaultProvider),
      ),
    );

    return c.json(status(), 200);
  });
}
