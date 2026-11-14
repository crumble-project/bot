import { chmodSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { Effect, Layer, ManagedRuntime, Schedule, type Scope } from "effect";
import { BotRuntime } from "../bots/runtime";
import { Bots, botsAccess } from "../bots/bots";
import { BotMessaging } from "../bot-messaging/bot-messaging";
import { BotActivity } from "../bots/bot-activity";
import { groupConversations } from "../group-chats/group-turns";
import { reviewConversations } from "../learning/review-kind";
import { BotExtensions } from "../bot-ports/bot-extensions";
import { reactionTools } from "../bots/reaction";
import { codemodeTools } from "../integrations/codemode";
import { configuredWebSearchTools } from "../web-search/web-search-tools";
import {
  Scheduler,
  schedulerAccess,
  type SchedulerAccess,
} from "../automations/scheduler";
import { BotSchedules, scheduleTools } from "../automations/bot-schedules";
import { Automations } from "../automations/automations";
import { AutomationDispatch } from "../automations/automation-dispatch";
import { ScriptRuns, scriptRunRetention } from "../automations/script-runs";
import { createAPI, type ApiServices } from "./api";
import { GroupChats, GroupTranscriptStore } from "../group-chats/group-chats";
import { groupLookupTools } from "../group-chats/group-lookup";
import { GroupTranscripts } from "../group-chats/group-transcripts";
import { historyTools } from "../history/history-tools";
import { BotSkills } from "../skills/skills";
import { LearningReview, learningReviews } from "../learning/learning-review";
import { SkillCurator, skillCuration } from "../skills/skill-curator";
import { skillUpdateChecks } from "../skills/skill-installer";
import { DefaultSkills } from "../skills/default-skills";
import { OwnerSkills } from "../skills/owner-skills";
import {
  integrationTools,
  McpIntegrations,
} from "../integrations/integrations";
import { McpServers } from "../integrations/mcp-servers";
import type { ClientDocument } from "../integrations/mcp-oauth";
import { coordinationTools } from "../bot-messaging/coordination";
import { displayTools } from "../display/display";
import { desktopControlAccess } from "../bot-desktop/desktop-control";
import { heldActionsAccess } from "../bot-desktop/held-actions";
import { chosenJudge } from "../bot-desktop/judge-settings";
import { accountJudge } from "../bot-desktop/desktop-intent";
import { ViewerTickets } from "../bot-desktop/desktop-viewer";
import type { Workspaces } from "../workspaces/workspace";
import { acquireWorkspaces } from "../workspaces/machine-workspaces";
import { Push, PushDelivery } from "../push/push";
import { PushRepository } from "../push/push-repository";
import { PushTransports } from "../push/push-transports";
import { ChatAttention } from "../push/chat-attention";
import { ProviderModels, accountModels } from "../providers/providers";
import { ProviderSignIns } from "../providers/provider-auth";
import { credentialsAccess } from "../credentials/credentials";
import { loginsAccess } from "../logins/logins";
import { desktopFillsAccess } from "../bot-desktop/desktop-fill-repository";
import { credentialInterception } from "../credentials/credential-interception";
import { coreLayer, type CoreServices } from "./core-layer";
import { runnerOf } from "../shared/runner";
import { builtinPlugins, builtinVendors } from "./builtin-plugins";
import { heldActionNotices } from "../bot-desktop/held-action-notices";
import { jobAnswers, jobQuestions, jobTools } from "./job-wiring";
import {
  conversationEnv,
  jobExtensions,
  pluginJobKinds,
  pluginProviders,
  Plugins,
  pluginWorkspaces,
  pluginWebSearchProviders,
  assertVendorIds,
} from "../plugins/plugins";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";
import { BotDeletion } from "../bot-ports/bot-deletion";
import { logged } from "../shared/app-errors";
import { BotWorkspaces } from "../workspaces/workspace";
import { desktopKeepAwake } from "../bot-desktop/keep-awake";
import { desktopScreenshotTools } from "../bot-desktop/desktop-screenshot";
import { AgentRepository } from "../bot-store/agent-repository";
import { BotRequests, botRequestTools } from "../bot-requests/bot-requests";
import { botSecretUseRetention } from "../bot-secrets/bot-secret-uses";
import { Secrets, secretText } from "../secrets/secrets";
import { MessageGateway } from "../message-gateway/message-gateway";
import { EventRelay } from "../event-sources/event-relay";
import { EventSources } from "../event-sources/event-sources";
import { EventDispatcher } from "../automations/event-dispatcher";
import { VoiceGateway } from "../voice-gateway/voice-gateway";
import { callMarkers } from "../voice-gateway/call-markers";
import { callOwnerTools } from "../voice-gateway/call-owner";
import { callConversations } from "../voice-gateway/call-conversation";
import { CallRequests } from "../voice-gateway/call-requests";
import {
  outsideCalls,
  recoverOutsideCalls,
} from "../voice-gateway/outside-calls";
import { requestCallTools } from "../voice-gateway/request-call";
import { eventPayloadTools } from "../automations/event-tools";
import { usesDesktop } from "../contract/tools";
import type { ServerSettings } from "./server-settings";

export type TenantOptions = {
  dataDir: string;
  skillsDir?: string | undefined;
  oauthClient?: ClientDocument | undefined;
  workspaceEnv: Record<string, string | undefined>;
  workspaces?:
    | Effect.Effect<Workspaces | undefined, never, Scope.Scope>
    | undefined;
  serverSettings: () => ServerSettings;
  tenantId: string;
};

export type TenantRuntime = {
  app: ReturnType<typeof createAPI>;
  token: string;
  workspaces: Workspaces | undefined;
  /** Deletes every bot's workspace, for an account being removed. A failure is logged, so it never rejects. */
  removeWorkspaces: () => Promise<void>;
  close: () => Promise<void>;
};

function accountLayer(options: TenantOptions, dataDir: string) {
  const skillsDir = resolve(
    options.skillsDir ?? resolve(import.meta.dir, "../../skills"),
  );

  const defaultSkills = DefaultSkills.layer(
    skillsDir,
    options.skillsDir !== undefined,
  );

  const base = Layer.mergeAll(defaultSkills, BotExtensions.layer).pipe(
    Layer.provideMerge(coreLayer(dataDir)),
  );

  const workspaces = Layer.unwrap(
    Effect.gen(function* () {
      const agents = yield* AgentRepository;
      const { serverSettings } = options;
      const run = runnerOf(yield* Effect.context<CoreServices>());

      const machineOptions = {
        dataDir,
        namePrefix: `crumble-${options.tenantId.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        wantsDesktop: (agentId: string) => {
          const agent = Effect.runSync(agents.get(agentId));

          return agent !== null && usesDesktop(agent);
        },
        size: () => ({
          cpus: serverSettings().workspaceCpus,
          memoryMib: serverSettings().workspaceMemoryMib,
        }),
        baseImage: () => serverSettings().codingImage,
        ...credentialInterception(run),
      };

      return BotWorkspaces.layer(
        options.workspaces ??
          acquireWorkspaces(() =>
            pluginWorkspaces(
              builtinVendors,
              options.workspaceEnv,
              machineOptions,
            ),
          ),
      );
    }),
  );

  const plugins = Layer.effect(
    Plugins,
    Effect.gen(function* () {
      const run = runnerOf(yield* Effect.context<CoreServices>());

      const installed = builtinPlugins({
        dataDir,
        secret: secretText(yield* Secrets),
        env: process.env,
        workspaces: yield* BotWorkspaces,
        questionGraceMs: () =>
          options.serverSettings().questionGraceMinutes * 60_000,
        desktopControl: desktopControlAccess(run),
        credentials: credentialsAccess(run),
        logins: {
          access: loginsAccess(run),
          fills: (agentId) => desktopFillsAccess(run, agentId),
        },
        intent: {
          judgeFor: accountJudge(() => run.runPromise(chosenJudge)),
          held: heldActionsAccess(run),
        },
      });

      assertVendorIds(
        "web search provider",
        WEB_SEARCH_PROVIDER_IDS,
        pluginWebSearchProviders(installed).map((provider) => provider.id),
      );

      return installed;
    }),
  );

  const models = Layer.unwrap(
    Plugins.use((installed) =>
      Effect.succeed(
        ProviderModels.layer(accountModels, pluginProviders(installed)),
      ),
    ),
  );

  const integrations = McpServers.layer.pipe(
    Layer.provideMerge(
      McpIntegrations.layer({ oauthClient: options.oauthClient }),
    ),
  );

  const runtime = Layer.unwrap(
    Effect.gen(function* () {
      const jobKinds = pluginJobKinds(yield* Plugins);

      return BotRuntime.layer(join(dataDir, "agents"), {
        jobExtensions: (agent) => jobExtensions(jobKinds, agent).job,
        conversationKinds: () => [
          groupConversations(),
          reviewConversations(),
          callConversations(),
        ],
        env: (agent, target, context) =>
          conversationEnv(jobKinds, agent, target, context),
      });
    }),
  );

  const bots = BotMessaging.layer.pipe(Layer.provideMerge(Bots.layer));

  const activity = Layer.effect(
    BotActivity,
    Bots.use((service) =>
      Effect.succeed(
        BotActivity.of({
          subscribe: (listener) => service.onActivity(listener),
        }),
      ),
    ),
  );

  const reviews = learningReviews.pipe(Layer.provide(LearningReview.layer));

  const curation = skillCuration.pipe(Layer.provide(SkillCurator.layer));

  const dispatch = Layer.effect(
    AutomationDispatch,
    Bots.use((service) => Effect.succeed(service.dispatch)),
  );

  const automations = Automations.layer.pipe(Layer.provide(dispatch));

  const scheduler = Scheduler.layer.pipe(Layer.provide(automations));

  const groups = GroupChats.layer.pipe(
    Layer.provide(
      GroupTranscriptStore.layer(
        () => new GroupTranscripts(join(dataDir, "groups")),
      ),
    ),
  );

  const schedules = BotSchedules.layer;
  const botRequests = BotRequests.layer;

  const attentionCleanup = Layer.effectDiscard(
    Effect.gen(function* () {
      const attention = yield* ChatAttention;
      yield* attention.cleanup.pipe(
        Effect.repeat(Schedule.spaced("1 minute")),
        Effect.forkScoped,
      );
    }),
  );

  const push = Layer.mergeAll(PushDelivery, attentionCleanup).pipe(
    Layer.provideMerge(Push.layerNoDeps),
    Layer.provideMerge(PushTransports.layer),
    Layer.provideMerge(PushRepository.layerNoDeps),
  );

  const leaves = Layer.mergeAll(
    reviews,
    curation,
    skillUpdateChecks,
    jobAnswers,
    jobQuestions,
    heldActionNotices,
    jobTools,
    coordinationTools,
    scheduleTools,
    eventPayloadTools,
    botRequestTools,
    groupLookupTools,
    historyTools,
    desktopKeepAwake,
    desktopScreenshotTools,
    push,
    MessageGateway.layer,
    EventSources.layer.pipe(Layer.provideMerge(EventRelay.layer)),
    Layer.mergeAll(
      callOwnerTools,
      callMarkers,
      requestCallTools,
      outsideCalls,
    ).pipe(
      Layer.provideMerge(CallRequests.layer),
      Layer.provideMerge(VoiceGateway.layer(options.tenantId)),
    ),
    EventDispatcher.layer.pipe(Layer.provide(automations)),
    scriptRunRetention,
    botSecretUseRetention,
  );

  const conversations = Layer.mergeAll(scheduler, groups, activity);

  /** Tools whose sandboxes must close after the bot runtime that uses them. */
  const sandboxedTools = Layer.mergeAll(
    integrationTools,
    codemodeTools,
    displayTools,
    configuredWebSearchTools,
    reactionTools,
  );

  const signIns = Layer.mergeAll(ProviderSignIns.layer, integrations);

  // Tiers from top to bottom: each may use every tier below it, and the account closes them top first.
  return leaves.pipe(
    Layer.provideMerge(schedules),
    Layer.provideMerge(botRequests),
    Layer.provideMerge(conversations),
    Layer.provideMerge(ScriptRuns.layer),
    Layer.provideMerge(workspaceCleanup),
    Layer.provideMerge(bots),
    Layer.provideMerge(runtime),
    Layer.provideMerge(Layer.mergeAll(BotSkills.layer, OwnerSkills.layer)),
    Layer.provideMerge(sandboxedTools),
    Layer.provideMerge(signIns),
    Layer.provideMerge(models),
    Layer.provideMerge(plugins),
    Layer.provideMerge(workspaces),
    Layer.provideMerge(base),
  );
}

const removeWorkspace = (workspaces: Workspaces, agentId: string) =>
  workspaces
    .remove(agentId)
    .pipe(logged("Removing a deleted bot's workspace failed", agentId));

const workspaceCleanup = Layer.effectDiscard(
  Effect.gen(function* () {
    const workspaces = yield* BotWorkspaces;

    if (workspaces)
      yield* (yield* BotDeletion).register((agentId) =>
        Effect.succeed(removeWorkspace(workspaces, agentId)),
      );
  }),
);

const removeAccountWorkspaces = Effect.fnUntraced(function* (
  workspaces: Workspaces | undefined,
) {
  if (!workspaces) return;

  const bots = yield* (yield* AgentRepository).list;

  yield* Effect.forEach(bots, (bot) => removeWorkspace(workspaces, bot.id), {
    concurrency: "unbounded",
    discard: true,
  });
}, logged("Removing an account's workspaces failed"));

// After the API: what recovery and start deliver may reach it. Work a layer's scope owns is already running.
const resumeAccount = Effect.fnUntraced(function* (scheduler: SchedulerAccess) {
  yield* (yield* Bots).recover;
  yield* (yield* ScriptRuns).recover;
  yield* (yield* GroupChats).recover;
  yield* (yield* MessageGateway).start;
  yield* (yield* EventRelay).start;
  yield* (yield* EventDispatcher).start;
  yield* recoverOutsideCalls;
  yield* (yield* VoiceGateway).start;
  scheduler.start();
});

export async function createTenant(
  options: TenantOptions,
): Promise<TenantRuntime> {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const account = ManagedRuntime.make(accountLayer(options, dataDir));

  try {
    return await account.runPromise(
      Effect.gen(function* () {
        const service = botsAccess(runnerOf(yield* Effect.context<Bots>()));

        const run = runnerOf(yield* Effect.context<ApiServices>());
        const scheduler = schedulerAccess(run);
        const token = randomBytes(32).toString("hex");

        const app = createAPI(
          { ...service, core: run, runtime: yield* BotRuntime },
          token,
          {
            viewerTickets: new ViewerTickets(Date.now, options.tenantId),
          },
        );

        yield* resumeAccount(scheduler);

        const workspaces = yield* BotWorkspaces;

        return {
          app,
          token,
          workspaces,
          removeWorkspaces: () =>
            account.runPromise(removeAccountWorkspaces(workspaces)),
          close: () => account.dispose(),
        };
      }),
    );
  } catch (error) {
    await account.dispose().catch(() => {});
    throw error;
  }
}
