import type { CrumblePlugin } from "../plugins/plugins";
import { DOORSTEP_PLUGIN_ID } from "../shared/vendors";
import { DOORSTEP_TOKEN_SETTING } from "./event-relay";

export const doorstepPlugin = (): CrumblePlugin => ({
  id: DOORSTEP_PLUGIN_ID,
  settings: [
    {
      key: DOORSTEP_TOKEN_SETTING,
      kind: "secret",
      label: "Doorstep account token",
      whenMissing: "Needed for event automations",
    },
  ],
});
