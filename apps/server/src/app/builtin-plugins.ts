import { claudeCodePlugin } from "../providers/claude-code/plugin";
import { codingPlugin } from "../jobs/coding";
import type { CredentialsAccess } from "../credentials/credentials";
import { desktopPlugin, type DesktopLogins } from "../bot-desktop/desktop-jobs";
import type { DesktopIntent } from "../bot-desktop/desktop-intent";
import type { DesktopControlAccess } from "../bot-desktop/desktop-control";
import type { CrumblePlugin, PluginVendors } from "../plugins/plugins";
import { bitwarden } from "../password-managers/bitwarden";
import { onePassword } from "../password-managers/one-password";
import { microsandboxWorkspacesFromEnv } from "../workspaces/microsandbox-workspaces";
import { railwayWorkspacesFromEnv } from "../workspaces/railway/railway-workspaces";
import { meliousPlugin } from "../providers/melious";
import type { Workspaces } from "../workspaces/workspace";
import { webSearchPlugin } from "../web-search/mixed";
import { exaPlugin } from "../web-search/exa";
import { discordPlugin } from "../message-gateway/discord/plugin";
import { doorstepPlugin } from "../event-sources/plugin";
import type { Effect } from "effect";
import type { SecretUnavailable } from "../secrets/secret-values";

export const builtinVendors: PluginVendors[] = [
  { id: "1password", passwordManagers: [onePassword] },
  { id: "bitwarden", passwordManagers: [bitwarden] },
  // Railway first: it runs only when CRUMBLE_WORKSPACE_BACKEND asks for it, while dev servers always set an image.
  { id: "railway", workspaceBackends: [railwayWorkspacesFromEnv] },
  { id: "microsandbox", workspaceBackends: [microsandboxWorkspacesFromEnv] },
];

export type PluginHost = {
  secret: (key: string) => Effect.Effect<string | undefined, SecretUnavailable>;
  dataDir: string;
  env: NodeJS.ProcessEnv;
  workspaces: Workspaces | undefined;
  desktopControl: DesktopControlAccess;
  credentials: CredentialsAccess;
  logins: DesktopLogins;
  intent: DesktopIntent;
  questionGraceMs: () => number;
};

export const builtinPlugins = (host: PluginHost): CrumblePlugin[] => [
  meliousPlugin(),
  claudeCodePlugin(host.dataDir, host.env),
  codingPlugin(host.workspaces, host.questionGraceMs, host.credentials),
  desktopPlugin(host.workspaces, host.desktopControl, host.logins, host.intent),
  webSearchPlugin(),
  exaPlugin(host.secret),
  discordPlugin(),
  doorstepPlugin(),
];
