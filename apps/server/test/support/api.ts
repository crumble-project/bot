import { Context, Effect, Layer, Scope } from "effect";
import { createAPI } from "../../src/app/api";
import type { ApiServices } from "../../src/app/api";
import type { CoreServices } from "../../src/app/core-layer";
import { standaloneScheduler } from "../../src/automations/scheduler-test-support";
import { Scheduler } from "../../src/automations/scheduler";
import { ScriptRuns } from "../../src/automations/script-runs";
import { ViewerTickets } from "../../src/bot-desktop/desktop-viewer";
import { BotRequests } from "../../src/bot-requests/bot-requests";
import type { BotsAccess } from "../../src/bots/bots";
import type { AgentRuntime } from "../../src/bots/runtime";
import { EventSources } from "../../src/event-sources/event-sources";
import { Library } from "../../src/files/library";
import { McpIntegrations } from "../../src/integrations/integrations";
import { mcpServersOver } from "../../src/integrations/integrations-test-support";
import { McpServers } from "../../src/integrations/mcp-servers";
import { MessageGateway } from "../../src/message-gateway/message-gateway";
import { pluginProviders, Plugins } from "../../src/plugins/plugins";
import type { CrumblePlugin } from "../../src/plugins/plugins";
import { standaloneSignIns } from "../../src/providers/provider-auth-test-support";
import { ProviderSignIns } from "../../src/providers/provider-auth";
import type { ProviderSignInsAccess } from "../../src/providers/provider-auth";
import { meliousPlugin } from "../../src/providers/melious";
import { Push } from "../../src/push/push";
import { runnerOf } from "../../src/shared/runner";
import type { Runner } from "../../src/shared/runner";
import { DefaultSkills } from "../../src/skills/default-skills";
import type { DefaultSkill } from "../../src/skills/default-skills";
import { OwnerSkills } from "../../src/skills/owner-skills";
import { VoiceGateway } from "../../src/voice-gateway/voice-gateway";
import { CallRequests } from "../../src/voice-gateway/call-requests";
import { BotWorkspaces } from "../../src/workspaces/workspace";
import type { Workspaces } from "../../src/workspaces/workspace";

export type TestServices = {
  library?: Library["Service"];
  scheduler?: { service: Scheduler["Service"] };
  push?: Runner<Push>;
  scriptRuns?: ScriptRuns["Service"];
  defaultSkills?: Array<DefaultSkill>;
  workspaces?: Workspaces | undefined;
  plugins?: ReadonlyArray<CrumblePlugin>;
  providerAuth?: ProviderSignInsAccess;
  viewerTickets?: ViewerTickets;
  voiceGateway?: VoiceGateway["Service"];
  callRequests?: CallRequests["Service"];
};

type TestBots = BotsAccess & {
  core: Runner<CoreServices>;
  runtime: AgentRuntime;
};

const mocked = <I, S extends object>(
  service: Context.Key<I, S>,
  implementation: Layer.PartialEffectful<S>,
): S =>
  Effect.runSync(
    Effect.scoped(Layer.build(Layer.mock(service, implementation))).pipe(
      Effect.map(Context.get(service)),
    ),
  );

const noPush = mocked(Push, {
  serverId: "",
  transports: { apns: false, fcm: false },
});

const noScriptRuns = ScriptRuns.of({
  start: () => Effect.succeed({ admitted: false }),
  recover: Effect.void,
  list: () => Effect.succeed([]),
});

const unreached = (member: string): never => {
  throw new Error(`${member} is not available in these tests`);
};

const noIntegrations = mocked(McpIntegrations, {
  oauthClient: undefined,
  failure: () => null,
  extensionsForAgent: () =>
    Promise.reject(unreached("McpIntegrations.extensionsForAgent")),
  codemodeNamespaces: () => unreached("McpIntegrations.codemodeNamespaces"),
  disconnect: () => Effect.void,
});

const noBotRequests = mocked(BotRequests, {});
const noCallRequests = mocked(CallRequests, {});
const noEventSources = mocked(EventSources, {});
const noMessageGateway = mocked(MessageGateway, { list: Effect.succeed([]) });

const testPush = (push: Runner<Push> | undefined) =>
  push?.runSync(Effect.flatMap(Push, Effect.succeed)) ?? noPush;

export const testVoiceGateway = (core: Runner<CoreServices>) =>
  core.runSync(
    Layer.buildWithScope(
      VoiceGateway.layer("test-account"),
      Scope.makeUnsafe(),
    ).pipe(Effect.map(Context.get(VoiceGateway))),
  );

function testServices(
  bots: TestBots,
  services: TestServices,
): Context.Context<ApiServices> {
  const plugins = services.plugins ?? [];

  const scheduler =
    services.scheduler ??
    standaloneScheduler(bots.core, (a, p, r, s) => bots.dispatch(a, p, r, s));

  const core = bots.core.runSync(Effect.context<CoreServices>());

  const context = core.pipe(
    Context.add(Library, services.library ?? Context.get(core, Library)),
    Context.add(McpServers, mcpServersOver(core, noIntegrations)),
    Context.add(Scheduler, scheduler.service),
    Context.add(ScriptRuns, services.scriptRuns ?? noScriptRuns),
    Context.add(BotWorkspaces, services.workspaces),
    Context.add(DefaultSkills, services.defaultSkills ?? []),
    Context.add(Plugins, plugins),
    Context.add(Push, testPush(services.push)),
    Context.add(
      ProviderSignIns,
      services.providerAuth ??
        standaloneSignIns(bots.core, pluginProviders([meliousPlugin()])),
    ),
    Context.add(BotRequests, noBotRequests),
    Context.add(CallRequests, services.callRequests ?? noCallRequests),
    Context.add(MessageGateway, noMessageGateway),
    Context.add(EventSources, noEventSources),
    Context.add(
      VoiceGateway,
      services.voiceGateway ?? testVoiceGateway(bots.core),
    ),
  );

  return Context.add(
    context,
    OwnerSkills,
    Effect.runSync(
      Layer.buildWithScope(OwnerSkills.layer, Scope.makeUnsafe()).pipe(
        Effect.map(Context.get(OwnerSkills)),
        Effect.provideContext(context),
      ),
    ),
  );
}

export const testAPI = (
  bots: TestBots,
  token: string,
  services: TestServices = {},
) =>
  createAPI({ ...bots, core: runnerOf(testServices(bots, services)) }, token, {
    viewerTickets: services.viewerTickets ?? new ViewerTickets(),
  });
