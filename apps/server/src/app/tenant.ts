import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import lockfile from "proper-lockfile";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BotRuntime } from "../bots/runtime";
import { CrumbleService } from "../bots/service";
import { BotActivity } from "../bots/bot-activity";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { reactionExtension } from "../bots/reaction";
import {
  Scheduler,
  schedulerAccess,
  type SchedulerAccess,
} from "../schedules/scheduler";
import { BotSchedules, scheduleExtension } from "../schedules/bot-schedules";
import { TaskDispatch } from "../schedules/task-dispatch";
import { createAPI } from "./api";
import { GroupChats } from "../group-chats/group-chats";
import { groupLookupExtension } from "../group-chats/group-lookup";
import { GroupTranscripts } from "../group-chats/group-transcripts";
import { historySource, historyToolsExtension } from "../history/history-tools";
import { HistorySearch } from "../history/history-search";
import { skillLibrary } from "../skills/skills";
import { LearningReview } from "../skills/learning-review";
import { SkillCurator } from "../skills/skill-curator";
import { loadCommonSkills } from "../skills/common-skills";
import { McpIntegrations } from "../integrations/integrations";
import { clientDocument, type ClientDocument } from "../integrations/mcp-oauth";
import { coordinationExtension } from "../bot-messaging/coordination";
import { displayExtension } from "../display/display";
import { DESKTOP_TOOL_NAME } from "../jobs/desktop";
import {
  desktopControlAccess,
  type ControlState,
} from "../bot-desktop/desktop-control";
import { ViewerTickets } from "../bot-desktop/desktop-viewer";
import type { Workspaces } from "../workspaces/workspace";
import { microsandboxWorkspacesFromEnv } from "../workspaces/microsandbox-workspaces";
import { railwayWorkspacesFromEnv } from "../workspaces/railway-workspaces";
import { Push, PushDelivery } from "../push/push";
import { ProviderModels } from "../providers/providers";
import {
  ProviderSignIns,
  providerSignInsAccess,
} from "../providers/provider-auth";
import { credentialsAccess } from "../credentials/credentials";
import { credentialAuthoritiesAccess } from "../credentials/credential-authority";
import { credentialProxy } from "../credentials/credential-proxy";
import { coreLayer, type CoreServices } from "../shared/core-layer";
import { runnerOf } from "../shared/runner";
import { builtinPlugins } from "./builtin-plugins";
import {
  jobEnv,
  jobExtensions,
  pluginJobKinds,
  pluginProviders,
} from "./plugins";
import {
  AccountStore,
  AccountWorkspaces,
  Bots,
  Charts,
  Codemode,
  CommonSkills,
  GroupChatsService,
  HistorySearchService,
  Plugins,
} from "./account-services";

export type TenantOptions = {
  dataDir: string;
  skillsDir?: string | undefined;
  publicUrl?: string | undefined;
  workspaces?: Workspaces | undefined;
  tenantId: string;
};

export type TenantRuntime = {
  app: ReturnType<typeof createAPI>;
  /** Internal API bearer used by the host auth router when dispatching requests. */
  token: string;
  service: CrumbleService;
  scheduler: SchedulerAccess;
  close: () => Promise<void>;
};

function httpsUrl(value: string) {
  const url = URL.canParse(value) ? new URL(value) : undefined;

  if (url?.protocol !== "https:" || url.search || url.hash)
    throw new Error(
      `publicUrl must be an https address without a query: ${value}`,
    );

  return url;
}

/** A value made by `acquire` that the layer's scope releases with `release`. */
const scoped = <A>(
  acquire: () => A,
  release: (value: A) => void | Promise<void>,
) =>
  Effect.acquireRelease(Effect.sync(acquire), (value) =>
    Effect.promise(async () => {
      await release(value);
    }),
  );

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

  const commonSkills = Layer.effect(
    CommonSkills,
    Effect.sync(() => {
      if (explicitSkillsDir && !existsSync(skillsDir))
        throw new Error(
          `Configured common skills directory does not exist: ${skillsDir}`,
        );

      if (!existsSync(skillsDir))
        console.warn(
          `Common skills directory not found; continuing with no common skills: ${skillsDir}`,
        );

      return loadCommonSkills(skillsDir);
    }),
  );

  const base = Layer.mergeAll(
    AccountStore.layer,
    commonSkills,
    BotExtensions.layer,
    Codemode.layer,
    Charts.layer,
  ).pipe(Layer.provideMerge(coreLayer(dataDir)));

  const workspaces = Layer.unwrap(
    Effect.gen(function* () {
      const run = runnerOf(yield* Effect.context<CoreServices>());
      const store = yield* AccountStore;
      const credentials = credentialsAccess(run);
      const authorities = credentialAuthoritiesAccess(run);

      const machineOptions = {
        namePrefix: `crumble-${options.tenantId.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        wantsDesktop: (agentId: string) =>
          store.getAgent(agentId)?.tools.includes(DESKTOP_TOOL_NAME) === true,
        caCertificate: (agentId: string) => authorities.certificate(agentId),
        intercept: (agentId: string) =>
          credentialProxy({
            agentId,
            authorities,
            grants: () => credentials.grants(agentId),
            recordUse: (name, use) => credentials.recordUse(agentId, name, use),
          }),
      };

      return AccountWorkspaces.layer(
        () =>
          options.workspaces ??
          railwayWorkspacesFromEnv(process.env, {
            ...machineOptions,
            dataDir,
          }) ??
          microsandboxWorkspacesFromEnv(process.env, machineOptions),
      );
    }),
  );

  const plugins = Layer.effect(
    Plugins,
    Effect.gen(function* () {
      const run = runnerOf(yield* Effect.context<CoreServices>());

      return builtinPlugins({
        dataDir,
        env: process.env,
        workspaces: yield* AccountWorkspaces,
        desktopControl: desktopControlAccess(run),
        credentials: credentialsAccess(run),
      });
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
        skillLibrary: skillLibrary(yield* AccountStore, yield* CommonSkills),
      });
    }),
  );

  const bots = Layer.effect(
    Bots,
    Effect.gen(function* () {
      const store = yield* AccountStore;
      const agents = yield* BotRuntime;

      return yield* scoped(
        () => new CrumbleService(store, agents),
        (service) => service.close(),
      );
    }),
  );

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

  const reviews = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* AccountStore;
      const service = yield* Bots;

      const learning = new LearningReview(store, yield* BotRuntime, (event) =>
        service.announce(event),
      );

      yield* Effect.promise(() => learning.recover());
      yield* scoped(
        () =>
          service.onSettled((execution) => learning.afterExecution(execution)),
        (stop) => stop(),
      );
    }),
  );

  const curation = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* AccountStore;

      yield* scoped(
        () => {
          const curator = new SkillCurator(store);
          curator.start();

          return curator;
        },
        (curator) => curator.stop(),
      );
    }),
  );

  const jobAnswers = Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* Bots;
      const jobKinds = pluginJobKinds(yield* Plugins);

      yield* scoped(
        () =>
          jobKinds.map((kind) =>
            kind.onAnswer((answer) => service.announceJobAnswer(answer)),
          ),
        (stops) => {
          for (const stop of stops) stop();
        },
      );
    }),
  );

  const dispatch = Layer.effect(
    TaskDispatch,
    Bots.use((service) =>
      Effect.succeed((agentId, prompt, requestId, scheduleId) =>
        Effect.tryPromise({
          try: () => service.dispatch(agentId, prompt, requestId, scheduleId),
          catch: (error) => error,
        }),
      ),
    ),
  );

  const scheduler = Scheduler.layer().pipe(Layer.provide(dispatch));

  const groups = Layer.effect(
    GroupChatsService,
    Effect.gen(function* () {
      const store = yield* AccountStore;
      const service = yield* Bots;

      return yield* scoped(
        () =>
          new GroupChats(
            store,
            new GroupTranscripts(join(dataDir, "groups")),
            service,
          ),
        (chats) => chats.close(),
      );
    }),
  );

  const schedules = BotSchedules.layer;

  const history = Layer.effect(
    HistorySearchService,
    Effect.gen(function* () {
      return new HistorySearch(
        historySource(
          yield* BotRuntime,
          yield* AccountStore,
          yield* GroupChatsService,
        ),
      );
    }),
  );

  // Each feature's tools for bots' chats, at the positions bots were offered them before the registry.
  const tools = Layer.effectDiscard(
    Effect.gen(function* () {
      const extensions = yield* BotExtensions;
      const integrated = yield* McpIntegrations;
      const service = yield* Bots;
      const groupChats = yield* GroupChatsService;
      const historySearch = yield* HistorySearchService;
      const botSchedules = yield* BotSchedules;
      const charts = yield* Charts;
      const sandbox = yield* Codemode;
      const jobKinds = pluginJobKinds(yield* Plugins);

      yield* extensions.register(ExtensionPosition.integrations, (agent) =>
        integrated.extensionsForAgent(agent),
      );
      yield* extensions.register(ExtensionPosition.coordination, (agent) => [
        coordinationExtension(agent, service),
      ]);
      yield* extensions.register(ExtensionPosition.groupLookup, (agent) => [
        groupLookupExtension(agent, groupChats),
      ]);
      yield* extensions.register(ExtensionPosition.historyTools, (agent) => [
        historyToolsExtension(agent, historySearch),
      ]);
      yield* extensions.register(ExtensionPosition.schedules, (agent) => [
        scheduleExtension(agent, botSchedules),
      ]);
      yield* extensions.register(ExtensionPosition.display, () => [
        displayExtension(charts),
      ]);
      yield* extensions.register(ExtensionPosition.reaction, () => [
        reactionExtension(),
      ]);
      yield* extensions.register(
        ExtensionPosition.jobs,
        (agent) => jobExtensions(jobKinds, agent).chat,
      );
      yield* extensions.register(ExtensionPosition.codemode, (agent) =>
        agent.tools.includes("codemode")
          ? [
              createCodemodeExtension({
                sandbox,
                namespaces: integrated.codemodeNamespaces(agent),
              }),
            ]
          : [],
      );
    }),
  );

  // A bot desktop stays awake while the owner holds it.
  const keepAwake = Layer.effectDiscard(
    Effect.gen(function* () {
      const machines = yield* AccountWorkspaces;
      const store = yield* AccountStore;

      const control = desktopControlAccess(
        runnerOf(yield* Effect.context<CoreServices>()),
      );

      const awake = new Map<string, () => void>();

      const holdAwake = (agentId: string, state: ControlState) => {
        if (!machines) return;

        if (state.holder === "owner" && !awake.has(agentId))
          awake.set(agentId, machines.keepAwake(agentId));
        else if (state.holder === "bot") {
          awake.get(agentId)?.();
          awake.delete(agentId);
        }
      };

      yield* scoped(
        () => control.subscribeAll(holdAwake),
        (stop) => stop(),
      );

      for (const agent of store.listAgents())
        holdAwake(agent.id, control.get(agent.id));
    }),
  );

  const push = PushDelivery.pipe(Layer.provideMerge(Push.layer(dataDir)));

  return Layer.mergeAll(
    reviews,
    curation,
    jobAnswers,
    tools,
    keepAwake,
    push,
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(schedules, history)),
    Layer.provideMerge(Layer.mergeAll(scheduler, groups, activity)),
    Layer.provideMerge(bots),
    Layer.provideMerge(runtime),
    Layer.provideMerge(Layer.mergeAll(ProviderSignIns.layer, integrations)),
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
        const service = yield* Bots;

        const scheduler = schedulerAccess(
          runnerOf(yield* Effect.context<Scheduler>()),
        );

        const workspaces = yield* AccountWorkspaces;
        const groupChats = yield* GroupChatsService;
        const plugins = yield* Plugins;

        const run = runnerOf(
          yield* Effect.context<CoreServices | Push | ProviderSignIns>(),
        );

        const token = randomBytes(32).toString("hex");

        const app = createAPI(
          service,
          scheduler,
          token,
          yield* McpIntegrations,
          {
            commonSkills: yield* CommonSkills,
            coding: workspaces !== undefined,
            desktop: workspaces?.desktop === true,
            restartWorkspace: async (agentId) =>
              workspaces?.restart(agentId, BACKGROUND_CONTEXT),
            groupChats,
            desktopControl: desktopControlAccess(run),
            viewerTickets: new ViewerTickets(Date.now, options.tenantId),
            externalAuth: new Map(
              pluginProviders(plugins).flatMap(({ provider, externalAuth }) =>
                externalAuth ? [[provider.id, externalAuth] as const] : [],
              ),
            ),
            ...(workspaces && {
              openDesktop: (agentId: string) =>
                workspaces.openDesktop(agentId, BACKGROUND_CONTEXT),
              startDesktop: (agentId: string) =>
                workspaces.startDesktop(agentId, BACKGROUND_CONTEXT),
            }),
            providerAuth: providerSignInsAccess(run),
            oauthClient,
            credentials: credentialsAccess(run),
          },
          run,
        );

        yield* Effect.promise(() => service.recover());
        yield* Effect.promise(() => groupChats.recover());
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
