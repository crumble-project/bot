import type { CrumblePlugin } from "../../plugins/plugins";
import { discordAdapter } from "./adapter";

export const discordPlugin = (): CrumblePlugin => ({
  id: "discord",
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
