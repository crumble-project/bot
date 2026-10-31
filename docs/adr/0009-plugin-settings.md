# Plugin settings

- Status: Accepted

A plugin that needs a value from the owner, such as an API key, needed its own field in `PluginHost`, its own routes, and its own web component. The Exa key has all three: `PluginHost.exaKey`, `PUT` and `DELETE /v1/web-search/exa-key`, and `ExaKey` in `web-search-settings.tsx`. This lets a plugin declare its settings instead. It answers the per-plugin settings storage that [ADR 0004](0004-plugin-interfaces.md) left open, for compiled-in plugins.

## Decision

- **A plugin declares its settings.** `CrumblePlugin.settings` lists `PluginSetting`s: a `key`, a `kind`, a `label`, and `whenMissing`, the status the owner sees while it has no value. The only kind is `secret`; a new kind is added when a plugin needs it.
- **Values are stored by plugin.** A secret setting is stored encrypted in the account's secrets as `<plugin ID>:<key>` (`pluginSettingKey`). The plugin reads it through `PluginHost.secret`, which also reads a password manager reference, so a new plugin needs no host field. Plugin IDs and setting keys are persistent identifiers.
- **One set of routes serves every plugin.** `GET /v1/plugin-settings` lists each plugin with settings, what it contributes, and whether each setting has a value; values are never returned. `PUT /v1/plugin-settings/{pluginId}/{key}` sets one, to a stored value or a password manager reference, `DELETE` removes it. An unknown plugin or key is 404.
- **One web component draws them.** `PluginSettingRows` renders the settings of the plugins that contribute a given kind, from the list. **Settings** > **Web search** shows the settings of web search plugins with it, so a new keyed web search provider needs only its name in `providerNames`.
- **The Exa key becomes a setting of the `web-search-exa` plugin.** A migration moves its stored key from `web-search:exa-key` to `web-search-exa:api-key`. `PUT` and `DELETE /v1/web-search/exa-key` and `exaKeyConfigured` stay, deprecated, reading the same value, so contract 3.x stays compatible.

## Not plugin settings

- **The account's default web search provider** chooses between plugins, so it belongs to the web search feature.
- **The judge model** is a desktop job setting whose choices come from the account's models, and its row explains which model judges now. A field list cannot say that without losing the text.

## Considered options

- **A Zod schema per plugin, published as JSON Schema.** Rejected for now: a secret is write-only, so its schema describes neither what the client reads nor what it writes, and clients would need a JSON Schema renderer for one field kind.
- **Keeping the stored key `web-search:exa-key`** with a per-setting storage name. Rejected: every new setting would choose its own name, and a migration of one row is cheap.
- **A Plugins page listing every plugin's settings.** Rejected: the owner looks for the Exa key where web search is chosen.

## Consequences

- A plugin's settings are only its own; a setting shared by plugins belongs to the feature that uses them.
- A plugin built before its secret is set reads the current value on each use, as `exaProvider` already did.
- Removing the deprecated Exa routes waits for contract 4.0.
