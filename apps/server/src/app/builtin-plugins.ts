import { claudeCodePlugin } from "../providers/claude-code/plugin";
import { codingPlugin } from "../jobs/coding";
import type { CredentialsAccess } from "../credentials/credentials";
import { desktopPlugin } from "../jobs/desktop";
import type { DesktopControlAccess } from "../bot-desktop/desktop-control";
import type { CrumblePlugin } from "../plugins/plugins";
import { meliousPlugin } from "../providers/providers";
import type { Workspaces } from "../workspaces/workspace";
import { webSearchPlugin } from "../web-search/mixed";
import { exaProvider } from "../web-search/exa";
import type { Effect } from "effect";

/** What the server hands the built-in plugins; each takes only the part it needs. */
export type PluginHost = {
  exaKey: Effect.Effect<string | undefined>;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  workspaces: Workspaces | undefined;
  desktopControl: DesktopControlAccess;
  /** The bots' credentials, offered to coding jobs. */
  credentials?: CredentialsAccess;
  /** Disable host-level Claude Code authentication for tenant runtimes. */
};

/** Every plugin compiled into the server, in the order their contributions are listed. */
export const builtinPlugins = (host: PluginHost): CrumblePlugin[] => [
  meliousPlugin(),
  claudeCodePlugin(host.dataDir, host.env),
  codingPlugin(host.workspaces, host.credentials),
  desktopPlugin(host.workspaces, host.desktopControl),
  webSearchPlugin(),
  { id: "web-search-exa", webSearchProviders: [exaProvider(host.exaKey)] },
];
