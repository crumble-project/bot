import type { Context as PiContext } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Agent } from "../contract/agents";
import { Context } from "effect";
import type { z } from "zod";
import type { externalAuthResponse } from "../contract/api-responses";
import type { ChatAdapter } from "../message-gateway/adapter";
import type {
  JobAnswer,
  JobAsked,
  JobExtensions,
  JobFinished,
} from "../jobs/jobs";
import type { WebSearchProvider } from "../web-search/provider";
import type { PasswordManagerVendor } from "../password-managers/password-manager";
import type { WorkspaceBackendOptions } from "../workspaces/machine-workspaces";
import type { ClosableWorkspaces } from "../workspaces/workspace";

export type ExternalAuth = z.output<typeof externalAuthResponse>;

export type ProviderContribution = {
  provider: Provider;
  externalAuth?: () => Promise<ExternalAuth>;
};

export type JobKindContribution = {
  /** Stored data depends on it: never rename. */
  kind: string;
  enabled: (agent: Agent) => boolean;
  extensions: (agent: Agent) => JobExtensions;
  env: (
    agentId: string,
    target: EnvTarget,
    context: PiContext,
  ) => Promise<ExecutionEnv | undefined>;
  botEnv?: (agentId: string) => ExecutionEnv;
  onAnswer: (listener: (answer: JobAnswer) => void) => () => void;
  onQuestion?: (listener: (asked: JobAsked) => Promise<void>) => () => void;
  onFinished?: (listener: (finished: JobFinished) => void) => () => void;
};

export type WorkspaceBackend = (
  env: Record<string, string | undefined>,
  options: WorkspaceBackendOptions,
) => ClosableWorkspaces | undefined;

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

export function assertVendorIds(
  kind: string,
  catalog: readonly string[],
  implemented: readonly string[],
) {
  const problems = [
    ...catalog.flatMap((id) => {
      const count = implemented.filter((other) => other === id).length;

      return count === 1 ? [] : [`${id} is implemented ${count} times`];
    }),
    ...implemented.flatMap((id) =>
      catalog.includes(id) ? [] : [`${id} is not in shared/vendors.ts`],
    ),
  ];

  if (problems.length)
    throw new Error(`Plugin ${kind} IDs: ${problems.join("; ")}`);
}

export const pluginPasswordManagers = (vendors: readonly PluginVendors[]) =>
  vendors.flatMap((vendor) => vendor.passwordManagers ?? []);

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

/** A value the owner sets for a plugin, such as an API key. See docs/adr/0009-plugin-settings.md. */
export type PluginSetting = {
  /** Stored data keys on it: never rename. */
  key: string;
  kind: "secret";
  label: string;
  whenMissing: string;
};

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
  settings?: PluginSetting[];
  chatAdapters?: ChatAdapter[];
};

export const pluginContributions = (plugin: CrumblePlugin) =>
  (
    ["providers", "jobKinds", "webSearchProviders", "chatAdapters"] as const
  ).filter((kind) => (plugin[kind]?.length ?? 0) > 0);

export const pluginProviders = (plugins: readonly CrumblePlugin[]) =>
  plugins.flatMap((plugin) => plugin.providers ?? []);

export const pluginJobKinds = (plugins: readonly CrumblePlugin[]) =>
  plugins.flatMap((plugin) => plugin.jobKinds ?? []);

export const pluginWebSearchProviders = (plugins: readonly CrumblePlugin[]) =>
  plugins.flatMap((plugin) => plugin.webSearchProviders ?? []);

export const pluginChatAdapters = (plugins: readonly CrumblePlugin[]) =>
  plugins.flatMap((plugin) => plugin.chatAdapters ?? []);

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

export async function conversationEnv(
  kinds: readonly JobKindContribution[],
  agent: Agent,
  target: EnvTarget,
  context: PiContext,
) {
  for (const kind of kinds) {
    const env = await kind.env(agent.id, target, context);

    if (env) return env;
  }

  return kinds
    .find((kind) => kind.botEnv && kind.enabled(agent))
    ?.botEnv?.(agent.id);
}

export class Plugins extends Context.Service<
  Plugins,
  readonly CrumblePlugin[]
>()("crumble/plugins/Plugins") {}
