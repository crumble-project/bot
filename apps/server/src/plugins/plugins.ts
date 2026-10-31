import type { Context as PiContext } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Agent } from "../shared/domain";
import { Context } from "effect";
import type { JobAnswer, JobExtensions } from "../jobs/jobs";
import type { WebSearchProvider } from "../web-search/provider";
import type { PasswordManagerVendor } from "../password-managers/password-manager";
import type {
  MachineWorkspaces,
  WorkspaceBackendOptions,
} from "../workspaces/machine-workspaces";

/** How a provider that signs in outside Crumble stands, shown to the owner instead of sign-in methods. */
export type ExternalAuth = {
  status:
    | "signed_in"
    | "signed_out"
    | "cli_missing"
    | "unsupported_version"
    | "error";
  cliVersion: string | null;
  qualifiedVersions: string[];
  signInCommand: string | null;
  signOutCommand: string | null;
  message: string | null;
};

/** A Pi AI provider; its `api` streams are the adapter. */
export type ProviderContribution = {
  provider: Provider;
  /** Present for providers whose sign-in happens outside Crumble; they have no Crumble credential to remove. */
  externalAuth?: () => Promise<ExternalAuth>;
};

/** A kind of background job a bot hands work to, such as coding or desktop jobs. */
export type JobKindContribution = {
  /** Stored data depends on it: never rename. */
  kind: string;
  /** Whether the bot may start jobs of this kind. */
  enabled: (agent: Agent) => boolean;
  extensions: (agent: Agent) => JobExtensions;
  /** The execution environment of this kind's jobs; undefined for a conversation that is not one of them. */
  env: (
    agentId: string,
    target: EnvTarget,
    context: PiContext,
  ) => Promise<ExecutionEnv | undefined>;
  /** Hears the bot's answer to each job report, for notifications. */
  onAnswer: (listener: (answer: JobAnswer) => void) => () => void;
};

/** A machine backend: its workspaces when the server's environment configures it, otherwise undefined. */
export type WorkspaceBackend = (
  env: Record<string, string | undefined>,
  options: WorkspaceBackendOptions,
) => MachineWorkspaces | undefined;

/**
 * A plugin's fixed part: vendors that need nothing from the account, so they exist before the account's services, which
 * read secrets and run workspaces through them. See docs/adr/0004-plugin-interfaces.md.
 */
export type PluginVendors = {
  /** Stored data and settings key on it: never rename. */
  id: string;
  passwordManagers?: PasswordManagerVendor[];
  /** Tried in list order; the first the environment configures runs the account's workspaces. */
  workspaceBackends?: WorkspaceBackend[];
};

export const pluginPasswordManagers = (vendors: readonly PluginVendors[]) =>
  vendors.flatMap((vendor) => vendor.passwordManagers ?? []);

/** The workspaces of the first backend the environment configures, if any. */
export function pluginWorkspaces(
  vendors: readonly PluginVendors[],
  env: Record<string, string | undefined>,
  options: WorkspaceBackendOptions,
) {
  for (const backend of vendors.flatMap(
    (vendor) => vendor.workspaceBackends ?? [],
  )) {
    const workspaces = backend(env, options);

    if (workspaces) return workspaces;
  }

  return undefined;
}

/**
 * A plugin's runtime part, built once the account's services exist: model providers, job kinds, and web search
 * providers. See docs/adr/0004-plugin-interfaces.md.
 */
export type CrumblePlugin = {
  /** Stored data and settings key on it: never rename. */
  id: string;
  providers?: ProviderContribution[];
  jobKinds?: JobKindContribution[];
  webSearchProviders?: WebSearchProvider[];
};

export const pluginProviders = (plugins: readonly CrumblePlugin[]) =>
  plugins.flatMap((plugin) => plugin.providers ?? []);

export const pluginJobKinds = (plugins: readonly CrumblePlugin[]) =>
  plugins.flatMap((plugin) => plugin.jobKinds ?? []);

export const pluginWebSearchProviders = (plugins: readonly CrumblePlugin[]) =>
  plugins.flatMap((plugin) => plugin.webSearchProviders ?? []);

/** The chat and job extensions of every job kind the bot may use. */
export const jobExtensions = (
  kinds: readonly JobKindContribution[],
  agent: Agent,
): JobExtensions => {
  const enabled = kinds.flatMap((kind) =>
    kind.enabled(agent) ? [kind.extensions(agent)] : [],
  );

  return {
    chat: enabled.flatMap((extensions) => extensions.chat),
    job: enabled.flatMap((extensions) => extensions.job),
  };
};

/** The first job kind that owns the conversation decides its environment. */
export async function jobEnv(
  kinds: readonly JobKindContribution[],
  agentId: string,
  target: EnvTarget,
  context: PiContext,
) {
  for (const kind of kinds) {
    const env = await kind.env(agentId, target, context);

    if (env) return env;
  }

  return undefined;
}

/** The plugins compiled into the server, as this account configures them. */
export class Plugins extends Context.Service<
  Plugins,
  readonly CrumblePlugin[]
>()("crumble/plugins/Plugins") {}
