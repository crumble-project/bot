import type { CrumblePlugin } from "../../plugins/plugins";
import { DISCORD_PLUGIN_ID, discordAdapter } from "./adapter";

export const discordPlugin = (): CrumblePlugin => ({
  id: DISCORD_PLUGIN_ID,
  settings: [
    {
      key: "token",
      kind: "secret",
      label: "Discord bot token",
      whenMissing: "Needed for the Discord message gateway",
    },
  ],
  chatAdapters: [discordAdapter()],
});
