import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { Secrets } from "../secrets/secrets";
import { SettingsRepository } from "../shared/settings-repository";
import { EXA_KEY } from "./exa";
import { DEFAULT_PROVIDER, defaultProvider } from "./provider";

const webSearchStatus = Effect.gen(function* () {
  const secrets = yield* Secrets;

  return {
    defaultProvider: yield* SettingsRepository.use(defaultProvider),
    exaKeyConfigured: (yield* secrets.status(EXA_KEY)).configured,
  };
});

export function registerWebSearchRoutes(options: {
  register: Register<Env, Secrets | SettingsRepository>;
}) {
  const { register } = options;

  register(routes.getWebSearch, function* (c) {
    return c.json(yield* webSearchStatus, 200);
  });
  register(routes.updateWebSearch, function* (c) {
    const { defaultProvider } = c.req.valid("json");
    const settings = yield* SettingsRepository;

    yield* settings.set(DEFAULT_PROVIDER, defaultProvider);

    return c.json(yield* webSearchStatus, 200);
  });
}
