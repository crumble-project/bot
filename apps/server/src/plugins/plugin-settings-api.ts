import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { Secrets } from "../password-managers/secrets";
import { secretInput } from "../shared/domain";
import { NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import {
  pluginContributions,
  pluginSettingKey,
  type CrumblePlugin,
  type PluginSetting,
} from "./plugins";

/** Every plugin's settings: listing whether each has a value, setting one, and removing one. */
export function registerPluginSettingRoutes(options: {
  register: Register;
  run: Runner<Secrets>;
  plugins?: readonly CrumblePlugin[] | undefined;
}) {
  const { register, run } = options;
  const secrets = run.runSync(Secrets.use(Effect.succeed));

  const plugins = (options.plugins ?? []).filter(
    (plugin) => (plugin.settings?.length ?? 0) > 0,
  );

  const describe = (plugin: CrumblePlugin, setting: PluginSetting) => ({
    ...setting,
    secret: run.runSync(
      secrets.status(pluginSettingKey(plugin.id, setting.key)),
    ),
  });

  const find = (pluginId: string, key: string) => {
    const plugin = plugins.find((candidate) => candidate.id === pluginId);

    const setting = plugin?.settings?.find(
      (candidate) => candidate.key === key,
    );

    if (!plugin || !setting)
      throw new NotFound({
        message: `${pluginId} has no setting ${key} on this server`,
      });

    return { plugin, setting, stored: pluginSettingKey(plugin.id, key) };
  };

  register(routes.pluginSettings, (c) =>
    c.json(
      {
        plugins: plugins.map((plugin) => ({
          id: plugin.id,
          contributes: pluginContributions(plugin),
          settings: (plugin.settings ?? []).map((setting) =>
            describe(plugin, setting),
          ),
        })),
      },
      200,
    ),
  );
  register(routes.setPluginSetting, async (c) => {
    const { plugin, setting, stored } = find(
      c.req.param("pluginId"),
      c.req.param("key"),
    );

    await run.runPromise(
      secrets.save(stored, secretInput.parse(await c.req.json())),
    );

    return c.json(describe(plugin, setting), 200);
  });
  register(routes.deletePluginSetting, (c) => {
    const { plugin, setting, stored } = find(
      c.req.param("pluginId"),
      c.req.param("key"),
    );

    run.runSync(secrets.delete(stored));

    return c.json(describe(plugin, setting), 200);
  });
}
