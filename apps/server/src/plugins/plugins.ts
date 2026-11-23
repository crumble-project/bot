import type { Context as PiContext } from "@earendil-works/chord";
import type { Provider } from "@earendil-works/pi-ai";
import type { EnvTarget } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Agent } from "../contract/agents";
import { Context } from "effect";
import type { z } from "zod";
import type { externalAuthResponse } from "../contract/api-responses";
import { PLUGIN_CONTRIBUTIONS } from "../contract/plugins";
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

export type PluginVendors = {
  id: string;
  passwordManagers?: Array<PasswordManagerVendor>;
  workspaceBackends?: Array<WorkspaceBackend>;
};

export function assertVendorIds(
  kind: string,
  catalog: ReadonlyArray<string>,
  implemented: ReadonlyArray<string>,
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

  if (problems.length) {
    throw new Error(`Plugin ${kind} IDs: ${problems.join("; ")}`);
  }
}

export const pluginPasswordManagers = (vendors: ReadonlyArray<PluginVendors>) =>
  vendors.flatMap((vendor) => vendor.passwordManagers ?? []);

export function pluginWorkspaces(
  vendors: ReadonlyArray<PluginVendors>,
  env: Record<string, string | undefined>,
  options: WorkspaceBackendOptions,
) {
  for (const backend of vendors.flatMap(
    (vendor) => vendor.workspaceBackends ?? [],
  )) {
    const workspaces = backend(env, options);

    if (workspaces) {
      return workspaces;
    }
  }

  return;
}

export type PluginSetting = {
  key: string;
  kind: "secret";
  label: string;
  whenMissing: string;
};

export type CrumblePlugin = {
  id: string;
  providers?: Array<ProviderContribution>;
  jobKinds?: Array<JobKindContribution>;
  webSearchProviders?: Array<WebSearchProvider>;
  settings?: Array<PluginSetting>;
  chatAdapters?: Array<ChatAdapter>;
};

export const pluginContributions = (plugin: CrumblePlugin) =>
  PLUGIN_CONTRIBUTIONS.filter((kind) => (plugin[kind]?.length ?? 0) > 0);

export const pluginProviders = (plugins: ReadonlyArray<CrumblePlugin>) =>
  plugins.flatMap((plugin) => plugin.providers ?? []);

export const pluginJobKinds = (plugins: ReadonlyArray<CrumblePlugin>) =>
  plugins.flatMap((plugin) => plugin.jobKinds ?? []);

export const pluginWebSearchProviders = (
  plugins: ReadonlyArray<CrumblePlugin>,
) => plugins.flatMap((plugin) => plugin.webSearchProviders ?? []);

export const pluginChatAdapters = (plugins: ReadonlyArray<CrumblePlugin>) =>
  plugins.flatMap((plugin) => plugin.chatAdapters ?? []);

export const jobExtensions = (
  kinds: ReadonlyArray<JobKindContribution>,
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
  kinds: ReadonlyArray<JobKindContribution>,
  agent: Agent,
  target: EnvTarget,
  context: PiContext,
) {
  for (const kind of kinds) {
    const env = await kind.env(agent.id, target, context);

    if (env) {
      return env;
    }
  }

  return kinds
    .find((kind) => kind.botEnv && kind.enabled(agent))
    ?.botEnv?.(agent.id);
}

export class Plugins extends Context.Service<
  Plugins,
  ReadonlyArray<CrumblePlugin>
>()("crumble/plugins/Plugins") {}
