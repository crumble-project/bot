import { chmodSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { Effect, Layer, ManagedRuntime, type Scope } from "effect";
import { BotRuntime } from "../bots/runtime";
import { Bots, botsAccess, type BotsAccess } from "../bots/bots";
import { BotMessaging } from "../bot-messaging/bot-messaging";
import { BotActivity } from "../bots/bot-activity";
import { BotExtensions } from "../bots/bot-extensions";
import { reactionTools } from "../bots/reaction";
import { codemodeTools } from "../bots/codemode";
import { configuredWebSearchTools } from "../web-search/web-search-tools";
import {
  Scheduler,
  schedulerAccess,
  type SchedulerAccess,
} from "../schedules/scheduler";
import { BotSchedules, scheduleTools } from "../schedules/bot-schedules";
import { TaskDispatch } from "../schedules/task-dispatch";
import { ScriptRuns } from "../schedules/script-runs";
import { createAPI } from "./api";
import { GroupChats, GroupTranscriptStore } from "../group-chats/group-chats";
import { groupLookupTools } from "../group-chats/group-lookup";
import { GroupTranscripts } from "../group-chats/group-transcripts";
import { historyTools } from "../history/history-tools";
import { BotSkills } from "../skills/skills";
import { LearningReview, learningReviews } from "../skills/learning-review";
import { SkillCurator, skillCuration } from "../skills/skill-curator";
import { CommonSkills } from "../skills/common-skills";
import {
  integrationTools,
  McpIntegrations,
} from "../integrations/integrations";
import { clientDocument, type ClientDocument } from "../integrations/mcp-oauth";
import { coordinationTools } from "../bot-messaging/coordination";
import { displayTools } from "../display/display";
import { DESKTOP_TOOL_NAME } from "../jobs/desktop";
import { desktopControlAccess } from "../bot-desktop/desktop-control";
import { heldActionsAccess } from "../bot-desktop/held-actions";
import { chosenJudge } from "../bot-desktop/judge-settings";
import { accountJudge } from "../jobs/desktop-intent";
import { ViewerTickets } from "../bot-desktop/desktop-viewer";
import type { Workspaces } from "../workspaces/workspace";
import { acquireWorkspaces } from "../workspaces/machine-workspaces";
import { Push, PushDelivery } from "../push/push";
import { ProviderModels } from "../providers/providers";
import { ProviderSignIns } from "../providers/provider-auth";
import { credentialsAccess } from "../credentials/credentials";
import { loginsAccess } from "../logins/logins";
import { desktopFillsAccess } from "../bot-desktop/desktop-fill-repository";
import { credentialAuthoritiesAccess } from "../credentials/credential-authority";
import { credentialProxy } from "../credentials/credential-proxy";
import { coreLayer, type CoreServices } from "./core-layer";
import { runnerOf } from "../shared/runner";
import { builtinPlugins, builtinVendors } from "./builtin-plugins";
import { heldActionNotices, jobAnswers, jobTools } from "./plugin-layers";
import {
  jobEnv,
  jobExtensions,
  pluginJobKinds,
  pluginProviders,
  Plugins,
  pluginWorkspaces,
  pluginWebSearchProviders,
  assertVendorIds,
} from "../plugins/plugins";
import { WEB_SEARCH_PROVIDER_IDS } from "../shared/vendors";
import { BotWorkspaces } from "../workspaces/workspace";
import { desktopKeepAwake } from "../bot-desktop/keep-awake";
import { AgentRepository } from "../bots/agent-repository";
import { BotRequests, botRequestTools } from "../bot-requests/bot-requests";
import { SecretRepository } from "../credentials/secret-repository";
import { keyedSecretReader } from "../password-managers/secret-references";
import { SecretValues } from "../password-managers/secret-values";
import { MessageGateway } from "../message-gateway/message-gateway";

export type TenantOptions = {
  dataDir: string;
  skillsDir?: string | undefined;
  publicUrl?: string | undefined;
  /** Replaces the workspaces from the environment; the account's scope owns what it acquires. */
  workspaces?:
    | Effect.Effect<Workspaces | undefined, never, Scope.Scope>
    | undefined;
  tenantId: string;
};

export type TenantRuntime = {
  app: ReturnType<typeof createAPI>;
  /** Internal API bearer used by the host auth router when dispatching requests. */
  token: string;
  service: BotsAccess;
  scheduler: SchedulerAccess;
  close: () => Promise<void>;
};

function isHttpsOrigin(url: URL) {
  return url.protocol === "https:" && !url.search && !url.hash;
}

function httpsUrl(value: string) {
  const url = URL.canParse(value) ? new URL(value) : undefined;

  if (!url || !isHttpsOrigin(url))
    throw new Error(
      `publicUrl must be an https address without a query: ${value}`,
    );

  return url;
}

/** Every part of one account, in dependency order; closing the account releases them in reverse. */
function accountLayer(
  options: TenantOptions,
  dataDir: string,
  oauthClient: ClientDocument | undefined,
) {
  const explicitSkillsDir =
    options.skillsDir ?? process.env["CRUMBLE_SKILLS_DIR"];

  const skillsDir = resolve(
    explicitSkillsDir ?? resolve(import.meta.dir, "../../skills"),
  );

  const commonSkills = CommonSkills.layer(
    skillsDir,
    explicitSkillsDir !== undefined,
  );

  const base = Layer.mergeAll(commonSkills, BotExtensions.layer).pipe(
    Layer.provideMerge(coreLayer(dataDir)),
  );

  const workspaces = Layer.unwrap(
    Effect.gen(function* () {
      const run = runnerOf(yield* Effect.context<CoreServices>());
      const agents = yield* AgentRepository;
      const credentials = credentialsAccess(run);
      const authorities = credentialAuthoritiesAccess(run);

      const machineOptions = {
        dataDir,
        namePrefix: `crumble-${options.tenantId.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        wantsDesktop: (agentId: string) =>
          Effect.runSync(agents.get(agentId))?.tools.includes(
            DESKTOP_TOOL_NAME,
          ) === true,
        caCertificate: (agentId: string) => authorities.certificate(agentId),
        intercept: (agentId: string) =>
          credentialProxy({
            agentId,
            authorities,
            grants: () => credentials.grants(agentId),
            value: (name) => credentials.value(agentId, name),
            recordUse: (name, use) => credentials.recordUse(agentId, name, use),
          }),
      };

      return BotWorkspaces.layer(
        options.workspaces ??
          acquireWorkspaces(() =>
            pluginWorkspaces(builtinVendors, process.env, machineOptions),
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
        secret: keyedSecretReader(yield* SecretRepository, yield* SecretValues),
        env: process.env,
        workspaces: yield* BotWorkspaces,
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
        ProviderModels.layer(pluginProviders(installed), {
          allowAmbientEnv: false,
        }),
      ),
    ),
  );

  const integrations = McpIntegrations.layer({ oauthClient });

  const runtime = Layer.unwrap(
    Effect.gen(function* () {
      const jobKinds = pluginJobKinds(yield* Plugins);

      return BotRuntime.layer(join(dataDir, "agents"), {
        taskExtensions: (agent) => jobExtensions(jobKinds, agent).job,
        env: (agentId, target, context) =>
          jobEnv(jobKinds, agentId, target, context),
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
    TaskDispatch,
    Bots.use((service) => Effect.succeed(service.dispatch)),
  );

  const scheduler = Scheduler.layer().pipe(Layer.provide(dispatch));

  const groups = GroupChats.layer.pipe(
    Layer.provide(
      GroupTranscriptStore.layer(
        () => new GroupTranscripts(join(dataDir, "groups")),
      ),
    ),
  );

  const schedules = BotSchedules.layer;
  const botRequests = BotRequests.layer;

  const push = PushDelivery.pipe(Layer.provideMerge(Push.layer(dataDir)));

  /** Background work and the bots' tool registrations: no other layer needs them. */
  const leaves = Layer.mergeAll(
    reviews,
    curation,
    jobAnswers,
    heldActionNotices,
    jobTools,
    coordinationTools,
    scheduleTools,
    botRequestTools,
    groupLookupTools,
    historyTools,
    desktopKeepAwake,
    push,
    MessageGateway.layer,
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
    Layer.provideMerge(bots),
    Layer.provideMerge(runtime),
    Layer.provideMerge(BotSkills.layer),
    Layer.provideMerge(sandboxedTools),
    Layer.provideMerge(signIns),
    Layer.provideMerge(models),
    Layer.provideMerge(plugins),
    Layer.provideMerge(workspaces),
    Layer.provideMerge(base),
  );
}

/** Builds one fully isolated Crumble runtime. No listener is created here. */
export async function createTenant(
  options: TenantOptions,
): Promise<TenantRuntime> {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const oauthClient = options.publicUrl
    ? clientDocument(httpsUrl(options.publicUrl))
    : undefined;

  // The data directory's lock is taken before anything opens it and released after everything closed it.
  const locked = Layer.unwrap(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.promise(() =>
          lockfile.lock(dataDir, { stale: 30000, update: 10000, retries: 0 }),
        ),
        (release) => Effect.promise(() => release()),
      );

      return accountLayer(options, dataDir, oauthClient);
    }),
  );

  const account = ManagedRuntime.make(locked);

  try {
    return await account.runPromise(
      Effect.gen(function* () {
        const bots = yield* Bots;
        const service = botsAccess(runnerOf(yield* Effect.context<Bots>()));

        const scheduler = schedulerAccess(
          runnerOf(yield* Effect.context<Scheduler>()),
        );

        const chats = yield* GroupChats;
        // Typed as the core, but its context holds every account service, which createAPI reads.
        const run = runnerOf(yield* Effect.context<CoreServices>());
        const token = randomBytes(32).toString("hex");

        const app = createAPI(
          { ...service, core: run, runtime: yield* BotRuntime },
          token,
          {
            scheduler,
            viewerTickets: new ViewerTickets(Date.now, options.tenantId),
            oauthClient,
          },
        );

        yield* bots.recover;
        yield* (yield* ScriptRuns).recover;
        yield* chats.recover;
        yield* (yield* MessageGateway).start;
        scheduler.start();

        return {
          app,
          token,
          service,
          scheduler,
          close: () => account.dispose(),
        };
      }),
    );
  } catch (error) {
    // A failed startup releases what it acquired; the error is the startup's, not the cleanup's.
    await account.dispose().catch(() => {});
    throw error;
  }
}
