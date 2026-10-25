import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import lockfile from "proper-lockfile";
import { Effect, Layer, ManagedRuntime } from "effect";
import { BotRuntime } from "../bots/runtime";
import { Bots, botsAccess, type BotsAccess } from "../bots/bots";
import { BotMessaging } from "../bot-messaging/bot-messaging";
import { BotActivity } from "../bots/bot-activity";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { reactionTools } from "../bots/reaction";
import { codemodeTools } from "../bots/codemode";
import {
  Scheduler,
  schedulerAccess,
  type SchedulerAccess,
} from "../schedules/scheduler";
import { BotSchedules, scheduleTools } from "../schedules/bot-schedules";
import { TaskDispatch } from "../schedules/task-dispatch";
import { createAPI } from "./api";
import {
  GroupChats,
  groupChatsAccess,
  GroupTranscriptStore,
} from "../group-chats/group-chats";
import { groupLookupTools } from "../group-chats/group-lookup";
import { GroupTranscripts } from "../group-chats/group-transcripts";
import { historyTools } from "../history/history-tools";
import { skillLibrary } from "../skills/skills";
import { LearningReview } from "../skills/learning-review";
import { SkillCurator } from "../skills/skill-curator";
import { loadCommonSkills } from "../skills/common-skills";
import {
  integrationTools,
  McpIntegrations,
} from "../integrations/integrations";
import { clientDocument, type ClientDocument } from "../integrations/mcp-oauth";
import { coordinationTools } from "../bot-messaging/coordination";
import { displayTools } from "../display/display";
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
  CommonSkills,
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
  service: BotsAccess;
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

  const reviews = Layer.effectDiscard(
    Effect.gen(function* () {
      const store = yield* AccountStore;
      const service = yield* Bots;

      const learning = new LearningReview(store, yield* BotRuntime, (event) =>
        Effect.runSync(service.announce(event)),
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
            kind.onAnswer((answer) =>
              Effect.runSync(service.announceJobAnswer(answer)),
            ),
          ),
        (stops) => {
          for (const stop of stops) stop();
        },
      );
    }),
  );

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

  // The tools of features not yet offering their own, at the positions bots were offered them before the registry.
  const tools = Layer.effectDiscard(
    Effect.gen(function* () {
      const extensions = yield* BotExtensions;
      const jobKinds = pluginJobKinds(yield* Plugins);

      yield* extensions.register(
        ExtensionPosition.jobs,
        (agent) => jobExtensions(jobKinds, agent).chat,
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
    coordinationTools,
    scheduleTools,
    groupLookupTools,
    historyTools,
    keepAwake,
    push,
  ).pipe(
    Layer.provideMerge(schedules),
    Layer.provideMerge(Layer.mergeAll(scheduler, groups, activity)),
    Layer.provideMerge(bots),
    Layer.provideMerge(runtime),
    // Below the runtime, so their sandboxes close after it.
    Layer.provideMerge(
      Layer.mergeAll(
        integrationTools,
        codemodeTools,
        displayTools,
        reactionTools,
      ),
    ),
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
        const bots = yield* Bots;
        const service = botsAccess(runnerOf(yield* Effect.context<Bots>()));

        const scheduler = schedulerAccess(
          runnerOf(yield* Effect.context<Scheduler>()),
        );

        const workspaces = yield* AccountWorkspaces;
        const chats = yield* GroupChats;
        const groupChats = groupChatsAccess(chats);
        const plugins = yield* Plugins;

        const run = runnerOf(
          yield* Effect.context<CoreServices | Push | ProviderSignIns>(),
        );

        const token = randomBytes(32).toString("hex");

        const app = createAPI(
          {
            ...service,
            store: yield* AccountStore,
            runtime: yield* BotRuntime,
          },
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

        yield* bots.recover;
        yield* chats.recover;
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
