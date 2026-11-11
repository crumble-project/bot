import type { CrumblePlugin } from "../../plugins/plugins";
import {
  DISCORD_PLUGIN_ID,
  DISCORD_TOKEN_SETTING,
  discordAdapter,
} from "./adapter";

export const discordPlugin = (): CrumblePlugin => ({
  id: DISCORD_PLUGIN_ID,
  settings: [
    {
      key: DISCORD_TOKEN_SETTING,
      kind: "secret",
      label: "Discord bot token",
      whenMissing: "Needed for the Discord message gateway",
    },
  ],
  chatAdapters: [discordAdapter()],
});
