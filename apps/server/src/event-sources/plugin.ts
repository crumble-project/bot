import type { CrumblePlugin } from "../plugins/plugins";

export const DOORSTEP_PLUGIN_ID = "doorstep";

export const doorstepPlugin = (): CrumblePlugin => ({
  id: DOORSTEP_PLUGIN_ID,
  settings: [
    {
      key: "token",
      kind: "secret",
      label: "Doorstep account token",
      whenMissing: "Needed for event automations",
    },
  ],
});
