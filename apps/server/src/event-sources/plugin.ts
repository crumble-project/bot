import type { CrumblePlugin } from "../plugins/plugins";
import { DOORSTEP_PLUGIN_ID } from "../shared/vendors";

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
