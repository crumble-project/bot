// The IDs of the vendors compiled-in plugins provide. The contract, the domain, and stored data key on them: never rename one.

export const WEB_SEARCH_PROVIDER_IDS = ["mixed", "exa"] as const;

export const PASSWORD_MANAGER_IDS = ["1password", "bitwarden"] as const;

export const DOORSTEP_PLUGIN_ID = "doorstep";

/** Where a plugin's setting is stored in the account's secrets. */
export const pluginSettingKey = (pluginId: string, key: string) =>
  `${pluginId}:${key}`;
