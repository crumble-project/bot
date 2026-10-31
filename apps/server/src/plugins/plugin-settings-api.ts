import { pluginSecretInput, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { SecretRepository } from "../credentials/secret-repository";
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
  run: Runner<SecretRepository>;
  plugins?: readonly CrumblePlugin[] | undefined;
}) {
  const { register, run } = options;

  const plugins = (options.plugins ?? []).filter(
    (plugin) => (plugin.settings?.length ?? 0) > 0,
  );

  const describe = (
    plugin: CrumblePlugin,
    setting: PluginSetting,
    stored: readonly string[],
  ) => ({
    ...setting,
    configured: stored.includes(pluginSettingKey(plugin.id, setting.key)),
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

  const storedKeys = () => run.runSync(SecretRepository.use((r) => r.listKeys));

  register(routes.pluginSettings, (c) => {
    const stored = storedKeys();

    return c.json(
      {
        plugins: plugins.map((plugin) => ({
          id: plugin.id,
          contributes: pluginContributions(plugin),
          settings: (plugin.settings ?? []).map((setting) =>
            describe(plugin, setting, stored),
          ),
        })),
      },
      200,
    );
  });
  register(routes.setPluginSetting, async (c) => {
    const { plugin, setting, stored } = find(
      c.req.param("pluginId"),
      c.req.param("key"),
    );

    const { value } = pluginSecretInput.parse(await c.req.json());

    run.runSync(SecretRepository.use((r) => r.set(stored, value)));

    return c.json(describe(plugin, setting, storedKeys()), 200);
  });
  register(routes.deletePluginSetting, (c) => {
    const { plugin, setting, stored } = find(
      c.req.param("pluginId"),
      c.req.param("key"),
    );

    run.runSync(SecretRepository.use((r) => r.delete(stored)));

    return c.json(describe(plugin, setting, storedKeys()), 200);
  });
}
