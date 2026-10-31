import { routes, apiKeyInput } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { SecretRepository } from "../credentials/secret-repository";
import type { Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import { z } from "zod";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";

type Services = SecretRepository | SettingsRepository;

export const DEFAULT_PROVIDER = "web-search:default-provider";
export const EXA_KEY = "web-search:exa-key";

export function registerWebSearchRoutes(
  register: Register,
  run: Runner<Services>,
) {
  const status = () => ({
    defaultProvider: z
      .enum(WEB_SEARCH_PROVIDER_IDS)
      .catch("mixed")
      .parse(
        run.runSync(SettingsRepository.use((r) => r.get(DEFAULT_PROVIDER))),
      ),
    exaKeyConfigured: run
      .runSync(SecretRepository.use((r) => r.listKeys))
      .includes(EXA_KEY),
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
  register(routes.setExaKey, async (c) => {
    const input = apiKeyInput.parse(await c.req.json());
    run.runSync(SecretRepository.use((r) => r.set(EXA_KEY, input.apiKey)));

    return c.json({ exaKeyConfigured: true }, 200);
  });
  register(routes.deleteExaKey, (c) => {
    run.runSync(SecretRepository.use((r) => r.delete(EXA_KEY)));

    return c.json({ exaKeyConfigured: false }, 200);
  });
}
