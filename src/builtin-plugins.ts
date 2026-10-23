import { claudeCodePlugin } from "./claude-code/plugin";
import { codingPlugin } from "./coding";
import { desktopPlugin } from "./desktop";
import type { DesktopControl } from "./desktop-control";
import type { CrumblePlugin } from "./plugins";
import { meliousPlugin } from "./providers";
import type { Workspaces } from "./workspace";

/** What the server hands the built-in plugins; each takes only the part it needs. */
export type PluginHost = {
  dataDir: string;
  env: NodeJS.ProcessEnv;
  workspaces: Workspaces | undefined;
  desktopControl: DesktopControl;
};

/** Every plugin compiled into the server, in the order their contributions are listed. */
export const builtinPlugins = (host: PluginHost): CrumblePlugin[] => [
  meliousPlugin(),
  claudeCodePlugin(host.dataDir, host.env),
  codingPlugin(host.workspaces),
  desktopPlugin(host.workspaces, host.desktopControl),
];
