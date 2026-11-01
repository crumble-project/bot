import { claudeCodePlugin } from "../providers/claude-code/plugin";
import { codingPlugin } from "../jobs/coding";
import type { CredentialsAccess } from "../credentials/credentials";
import { desktopPlugin, type DesktopLogins } from "../jobs/desktop";
import type { DesktopIntent } from "../jobs/desktop-intent";
import type { DesktopControlAccess } from "../bot-desktop/desktop-control";
import type { CrumblePlugin, PluginVendors } from "../plugins/plugins";
import { bitwarden } from "../password-managers/bitwarden";
import { onePassword } from "../password-managers/one-password";
import { microsandboxWorkspacesFromEnv } from "../workspaces/microsandbox-workspaces";
import { railwayWorkspacesFromEnv } from "../workspaces/railway-workspaces";
import { meliousPlugin } from "../providers/providers";
import type { Workspaces } from "../workspaces/workspace";
import { webSearchPlugin } from "../web-search/mixed";
import { exaPlugin } from "../web-search/exa";
import { discordPlugin } from "../message-gateway/discord/plugin";
import { doorstepPlugin } from "../event-sources/plugin";
import type { Effect } from "effect";
import type { SecretUnavailable } from "../password-managers/secret-values";

/** The fixed parts of the plugins compiled into the server, in the order their vendors are listed. */
export const builtinVendors: PluginVendors[] = [
  { id: "1password", passwordManagers: [onePassword] },
  { id: "bitwarden", passwordManagers: [bitwarden] },
  // Railway first: it runs only when CRUMBLE_WORKSPACE_BACKEND asks for it, while dev servers always set an image.
  { id: "railway", workspaceBackends: [railwayWorkspacesFromEnv] },
  { id: "microsandbox", workspaceBackends: [microsandboxWorkspacesFromEnv] },
];

/** What the server hands the built-in plugins; each takes only the part it needs. */
export type PluginHost = {
  /** Reads a value from the account's secrets, such as a plugin setting, from its password manager when it holds a reference. */
  secret: (key: string) => Effect.Effect<string | undefined, SecretUnavailable>;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  workspaces: Workspaces | undefined;
  desktopControl: DesktopControlAccess;
  /** The bots' credentials, offered to coding jobs. */
  credentials?: CredentialsAccess;
  /** The bots' logins, filled by desktop jobs. */
  logins?: DesktopLogins;
  /** What desktop jobs check their actions with before they act. */
  intent?: DesktopIntent;
  /** Disable host-level Claude Code authentication for tenant runtimes. */
};

/** Every plugin compiled into the server, in the order their contributions are listed. */
export const builtinPlugins = (host: PluginHost): CrumblePlugin[] => [
  meliousPlugin(),
  claudeCodePlugin(host.dataDir, host.env),
  codingPlugin(host.workspaces, host.credentials),
  desktopPlugin(host.workspaces, host.desktopControl, host.logins, host.intent),
  webSearchPlugin(),
  exaPlugin(host.secret),
  discordPlugin(),
  doorstepPlugin(),
];
