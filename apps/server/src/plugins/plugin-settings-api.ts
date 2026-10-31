import { pluginSecretInput, routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { SecretRepository } from "../credentials/secret-repository";
import type { PasswordManagers } from "../password-managers/password-manager";
import { checkSecretReference } from "../password-managers/secret-references";
import { SecretValues } from "../password-managers/secret-values";
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
  run: Runner<SecretRepository | SecretValues | PasswordManagers>;
  plugins?: readonly CrumblePlugin[] | undefined;
}) {
  const { register, run } = options;

  const plugins = (options.plugins ?? []).filter(
    (plugin) => (plugin.settings?.length ?? 0) > 0,
  );

  const sourceOf = (key: string) =>
    run.runSync(SecretRepository.use((r) => r.source(key)));

  const describe = (plugin: CrumblePlugin, setting: PluginSetting) => {
    const source = sourceOf(pluginSettingKey(plugin.id, setting.key));
    const reference = source && "reference" in source ? source : null;

    return {
      ...setting,
      configured: source !== undefined,
      passwordManager: reference?.passwordManager ?? null,
      reference: reference?.reference ?? null,
    };
  };

  /** Drops the cached value of a reference the setting no longer reads from. */
  const forgetReplaced = (key: string, before: ReturnType<typeof sourceOf>) => {
    const after = sourceOf(key);

    if (
      before &&
      "reference" in before &&
      !(
        after &&
        "reference" in after &&
        after.passwordManager === before.passwordManager &&
        after.reference === before.reference
      )
    )
      run.runSync(
        SecretValues.use((values) =>
          values.forget(before.passwordManager, before.reference),
        ),
      );
  };

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

    const input = pluginSecretInput.parse(await c.req.json());
    const before = sourceOf(stored);

    const { value, reference } = input;

    if (reference) {
      await run.runPromise(checkSecretReference(reference));
      run.runSync(
        SecretRepository.use((r) => r.setReference(stored, reference)),
      );
    } else if (value)
      run.runSync(SecretRepository.use((r) => r.set(stored, value)));

    forgetReplaced(stored, before);

    return c.json(describe(plugin, setting), 200);
  });
  register(routes.deletePluginSetting, (c) => {
    const { plugin, setting, stored } = find(
      c.req.param("pluginId"),
      c.req.param("key"),
    );

    const before = sourceOf(stored);
    run.runSync(SecretRepository.use((r) => r.delete(stored)));
    forgetReplaced(stored, before);

    return c.json(describe(plugin, setting), 200);
  });
}
