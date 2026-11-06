import { Context, Effect, Layer, Scope } from "effect";
import { createAPI, type ApiServices } from "../../src/app/api";
import type { CoreServices } from "../../src/app/core-layer";
import { standaloneScheduler } from "../../src/automations/scheduler-test-support";
import { Scheduler } from "../../src/automations/scheduler";
import { ScriptRuns } from "../../src/automations/script-runs";
import { ViewerTickets } from "../../src/bot-desktop/desktop-viewer";
import { BotRequests } from "../../src/bot-requests/bot-requests";
import type { BotsAccess } from "../../src/bots/bots";
import type { AgentRuntime } from "../../src/bots/runtime";
import { EventSources } from "../../src/event-sources/event-sources";
import { GroupChats } from "../../src/group-chats/group-chats";
import { McpIntegrations } from "../../src/integrations/integrations";
import { mcpServersOver } from "../../src/integrations/integrations-test-support";
import { McpServers } from "../../src/integrations/mcp-servers";
import { MessageGateway } from "../../src/message-gateway/message-gateway";
import {
  pluginProviders,
  Plugins,
  type CrumblePlugin,
} from "../../src/plugins/plugins";
import { standaloneSignIns } from "../../src/providers/provider-auth-test-support";
import {
  ProviderSignIns,
  type ProviderSignInsAccess,
} from "../../src/providers/provider-auth";
import { meliousPlugin } from "../../src/providers/melious";
import { Push } from "../../src/push/push";
import { runnerOf, type Runner } from "../../src/shared/runner";
import {
  DefaultSkills,
  type DefaultSkill,
} from "../../src/skills/default-skills";
import { OwnerSkills } from "../../src/skills/owner-skills";
import { BotWorkspaces, type Workspaces } from "../../src/workspaces/workspace";

export type TestServices = {
  scheduler?: { service: Scheduler["Service"] };
  groupChats?: { service: GroupChats["Service"] };
  push?: Runner<Push>;
  scriptRuns?: ScriptRuns["Service"];
  defaultSkills?: DefaultSkill[];
  workspaces?: Workspaces | undefined;
  plugins?: readonly CrumblePlugin[];
  providerAuth?: ProviderSignInsAccess;
  viewerTickets?: ViewerTickets;
};

type TestBots = BotsAccess & {
  core: Runner<CoreServices>;
  runtime: AgentRuntime;
};

// SAFETY: a fixture that reaches a route of one of these supplies the real service.
const notReached = <S>() => ({}) as S;

const noPush = Push.of({
  ...notReached<Push["Service"]>(),
  serverId: "",
  transports: { apns: false, fcm: false },
});

const noScriptRuns = ScriptRuns.of({
  start: () => Effect.succeed({ admitted: false }),
  recover: Effect.void,
  list: () => Effect.succeed([]),
});

const noIntegrations = McpIntegrations.of({
  ...notReached<McpIntegrations["Service"]>(),
  oauthClient: undefined,
  failure: () => null,
  disconnect: () => Effect.void,
});

function testServices(
  bots: TestBots,
  services: TestServices,
): Context.Context<ApiServices> {
  const plugins = services.plugins ?? [];

  const scheduler =
    services.scheduler ??
    standaloneScheduler(bots.core, (a, p, r, s) => bots.dispatch(a, p, r, s));

  const push = services.push?.runSync(Push.use(Effect.succeed)) ?? noPush;

  const core = bots.core.runSync(Effect.context<CoreServices>());

  const context = core.pipe(
    Context.add(McpServers, mcpServersOver(core, noIntegrations)),
    Context.add(Scheduler, scheduler.service),
    Context.add(ScriptRuns, services.scriptRuns ?? noScriptRuns),
    Context.add(BotWorkspaces, services.workspaces),
    Context.add(DefaultSkills, services.defaultSkills ?? []),
    Context.add(Plugins, plugins),
    Context.add(
      GroupChats,
      services.groupChats?.service ?? notReached<GroupChats["Service"]>(),
    ),
    Context.add(Push, push),
    Context.add(
      ProviderSignIns,
      services.providerAuth ??
        standaloneSignIns(bots.core, pluginProviders([meliousPlugin()])),
    ),
    Context.add(BotRequests, notReached<BotRequests["Service"]>()),
    Context.add(
      MessageGateway,
      MessageGateway.of({
        ...notReached<MessageGateway["Service"]>(),
        list: Effect.succeed([]),
      }),
    ),
    Context.add(EventSources, notReached<EventSources["Service"]>()),
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
