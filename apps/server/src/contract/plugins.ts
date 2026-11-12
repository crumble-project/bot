import * as vendors from "../shared/vendors";

// Bound by name, not re-exported: `web` may import `contract`, never `shared`.
export const { DOORSTEP_PLUGIN_ID, pluginSettingKey } = vendors;

/** What a plugin can add to the server; each names the `CrumblePlugin` field that holds it. */
export const PLUGIN_CONTRIBUTIONS = [
  "providers",
  "jobKinds",
  "webSearchProviders",
  "chatAdapters",
] as const;
