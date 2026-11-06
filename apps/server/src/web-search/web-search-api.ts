import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { Secrets } from "../secrets/secrets";
import type { Runner } from "../shared/runner";
import { SettingsRepository } from "../shared/settings-repository";
import { EXA_KEY } from "./exa";
import { DEFAULT_PROVIDER, defaultProvider } from "./provider";

type Services = Secrets | SettingsRepository;

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
