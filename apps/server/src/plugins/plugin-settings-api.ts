import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { pluginSettingKey } from "../shared/vendors";
import { Secrets } from "../secrets/secrets";
import { NotFound } from "../shared/errors";
import {
  pluginContributions,
  type CrumblePlugin,
  type PluginSetting,
} from "./plugins";

const findSetting = (
  plugins: readonly CrumblePlugin[],
  pluginId: string,
  key: string,
) => {
  const plugin = plugins.find((candidate) => candidate.id === pluginId);
  const setting = plugin?.settings?.find((candidate) => candidate.key === key);

  if (!plugin || !setting)
    throw new NotFound({
      message: `${pluginId} has no setting ${key} on this server`,
    });

  return { plugin, setting, stored: pluginSettingKey(plugin.id, key) };
};

const describe = Effect.fnUntraced(function* (
  plugin: CrumblePlugin,
  setting: PluginSetting,
) {
  const secrets = yield* Secrets;

  return {
    ...setting,
    secret: yield* secrets.status(pluginSettingKey(plugin.id, setting.key)),
  };
});

export function registerPluginSettingRoutes(options: {
  register: Register<Env, Secrets>;
  plugins: readonly CrumblePlugin[];
}) {
  const { register } = options;

  const plugins = options.plugins.filter(
    (plugin) => (plugin.settings?.length ?? 0) > 0,
  );

  const updateSetting = Effect.fnUntraced(function* <E>(
    pluginId: string,
    key: string,
    update: (
      secrets: Secrets["Service"],
      stored: string,
    ) => Effect.Effect<unknown, E>,
  ) {
    const { plugin, setting, stored } = findSetting(plugins, pluginId, key);
    const secrets = yield* Secrets;

    yield* update(secrets, stored);

    return yield* describe(plugin, setting);
  });

  register(routes.pluginSettings, function* (c) {
    return c.json(
      {
        plugins: yield* Effect.forEach(plugins, (plugin) =>
          Effect.gen(function* () {
            return {
              id: plugin.id,
              contributes: pluginContributions(plugin),
              settings: yield* Effect.forEach(
                plugin.settings ?? [],
                (setting) => describe(plugin, setting),
              ),
            };
          }),
        ),
      },
      200,
    );
  });
  register(routes.setPluginSetting, function* (c) {
    return c.json(
      yield* updateSetting(
        c.req.param("pluginId"),
        c.req.param("key"),
        (secrets, stored) => secrets.save(stored, c.req.valid("json")),
      ),
      200,
    );
  });
  register(routes.deletePluginSetting, function* (c) {
    return c.json(
      yield* updateSetting(
        c.req.param("pluginId"),
        c.req.param("key"),
        (secrets, stored) => secrets.delete(stored),
      ),
      200,
    );
  });
}
