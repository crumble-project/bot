import * as vendors from "../shared/vendors";

// Bound by name, not re-exported: `web` may import `contract`, never `shared`.
export const { DOORSTEP_PLUGIN_ID, pluginSettingKey } = vendors;
