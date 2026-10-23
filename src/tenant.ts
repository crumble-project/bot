import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import lockfile from "proper-lockfile";
import { Store } from "./store";
import { AgentRuntime } from "./runtime";
import { CrumbleService, OWNER_TIMEZONE } from "./service";
import { Scheduler } from "./scheduler";
import { createAPI } from "./api";
import { GroupChats } from "./group-chats";
import { groupLookupExtension } from "./group-lookup";
import { historySource, historyToolsExtension } from "./history-tools";
import { HistorySearch } from "./history-search";
import {
  assertOwnMemoryInGroup,
  changeSourceOf,
  memorySourceOf,
} from "./memory-sources";
import { skillLibrary } from "./skills";
import { LearningReview } from "./learning-review";
import { SkillCurator } from "./skill-curator";
import type { ChangeBy } from "./domain";
import type { MemoryContext } from "./runtime";
import { GroupTranscripts } from "./group-transcripts";
import { AppError } from "./domain";
import { MCPIntegrations } from "./integrations";
import { BotSchedules, scheduleExtension } from "./bot-schedules";
import { coordinationExtension } from "./coordination";
import { ChartCompiler } from "./charts";
import { displayExtension } from "./display";
import { reactionExtension } from "./reaction";
import { DESKTOP_TOOL_NAME } from "./desktop";
import { DesktopControl, type ControlState } from "./desktop-control";
import { ViewerTickets } from "./desktop-viewer";
import type { Workspaces } from "./workspace";
import { microsandboxWorkspacesFromEnv } from "./microsandbox-workspaces";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { loadCommonSkills } from "./common-skills";
import { PushManager, PushStore } from "./push";
import { providerModels } from "./providers";
import { builtinPlugins } from "./builtin-plugins";
import {
  jobEnv,
  jobExtensions,
  pluginJobKinds,
  pluginProviders,
} from "./plugins";
import { ProviderCredentials } from "./provider-credentials";
import { ProviderAuth } from "./provider-auth";
import { clientDocument } from "./mcp-oauth";

export type TenantOptions = {
  dataDir: string;
  skillsDir?: string;
  publicUrl?: string;
  workspaces?: Workspaces;
  tenantId: string;
};

export type TenantRuntime = {
  app: ReturnType<typeof createAPI>;
  /** Internal API bearer used by the host auth router when dispatching requests. */
  token: string;
  service: CrumbleService;
  scheduler: Scheduler;
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

/** Builds one fully isolated Crumble runtime. No listener is created here. */
export async function createTenant(
  options: TenantOptions,
): Promise<TenantRuntime> {
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const release = await lockfile.lock(dataDir, {
    stale: 30000,
    update: 10000,
    retries: 0,
  });

  const partialCleanup: Array<() => Promise<void> | void> = [];
  let push: PushManager | undefined;
  let providerAuth: ProviderAuth | undefined;

  try {
    const explicitSkillsDir =
      options.skillsDir ?? process.env.CRUMBLE_SKILLS_DIR;

    const skillsDir = resolve(
      explicitSkillsDir ?? resolve(import.meta.dir, "../skills"),
    );

    if (explicitSkillsDir && !existsSync(skillsDir))
      throw new Error(
        `Configured common skills directory does not exist: ${skillsDir}`,
      );

    if (!existsSync(skillsDir))
      console.warn(
        `Common skills directory not found; continuing with no common skills: ${skillsDir}`,
      );
    const commonSkills = loadCommonSkills(skillsDir);
    const store = new Store(dataDir);
    partialCleanup.push(() => store.close());

    const workspaces =
      options.workspaces ??
      microsandboxWorkspacesFromEnv(process.env, {
        namePrefix: `crumble-${options.tenantId.replace(/[^A-Za-z0-9_-]/g, "-")}`,
        wantsDesktop: (agentId) =>
          store.getAgent(agentId)?.tools.includes(DESKTOP_TOOL_NAME) === true,
      });

    partialCleanup.push(() => workspaces?.close(BACKGROUND_CONTEXT));
    const desktopControl = new DesktopControl(store);

    const plugins = builtinPlugins({
      dataDir,
      env: process.env,
      workspaces,
      desktopControl,
      claudeCode: false,
    });

    const providers = pluginProviders(plugins);
    const jobKinds = pluginJobKinds(plugins);
    store.migrateProviderCredentials(
      providerModels(undefined, providers, { allowAmbientEnv: false })
        .getProviders()
        .map((provider) => provider.id),
    );
    const credentials = new ProviderCredentials(store);

    const models = providerModels(credentials, providers, {
      allowAmbientEnv: false,
    });

    providerAuth = new ProviderAuth(store, credentials, models);
    partialCleanup.push(() => providerAuth?.close());

    const oauthClient = options.publicUrl
      ? clientDocument(httpsUrl(options.publicUrl))
      : undefined;

    const integrations = new MCPIntegrations(store, { oauthClient });
    partialCleanup.push(() => integrations.close());

    const codemodeSandbox = new CodemodeSandbox({
      memoryLimitBytes: 256 * 1024 * 1024,
    });

    partialCleanup.push(() => codemodeSandbox.close());
    const charts = new ChartCompiler();
    partialCleanup.push(() => charts.close());

    const usesSharedMemory = (agentId: string) =>
      store.getAgent(agentId)?.sharedMemory === true;

    const reachableMemory = (agentId: string, id: string) => {
      const memory = store.getMemory(id);

      return memory?.agentId === agentId ||
        (memory?.agentId === null && usesSharedMemory(agentId))
        ? memory
        : null;
    };

    let service!: CrumbleService;
    let schedules!: BotSchedules;
    let groupChats!: GroupChats;
    let historySearch!: HistorySearch;

    const memoryChangeBy = (
      agentId: string,
      context: MemoryContext,
    ): ChangeBy =>
      context.reviewOf
        ? { actor: "review", source: { executionId: context.reviewOf } }
        : { actor: "bot", source: changeSourceOf(store, agentId, context) };

    const runtime = new AgentRuntime(join(dataDir, "agents"), {
      models,
      currentAgent: (id) => store.getAgent(id),
      ownerTimezone: () => store.getSetting<string>(OWNER_TIMEZONE),
      extensions: async (agent) => [
        ...(await integrations.extensionsForAgent(agent)),
        coordinationExtension(agent, service),
        groupLookupExtension(agent, groupChats),
        historyToolsExtension(agent, historySearch),
        scheduleExtension(agent, schedules),
        displayExtension(charts),
        reactionExtension(),
        ...jobExtensions(jobKinds, agent).chat,
        ...(agent.tools.includes("codemode")
          ? [
              createCodemodeExtension({
                sandbox: codemodeSandbox,
                namespaces: integrations.codemodeNamespaces(agent),
              }),
            ]
          : []),
      ],
      taskExtensions: (agent) => jobExtensions(jobKinds, agent).job,
      env: (agentId, target, context) =>
        jobEnv(jobKinds, agentId, target, context),
      listMemory: (agentId) => [
        ...store.listMemories(agentId),
        ...(usesSharedMemory(agentId)
          ? store
              .listMemories(null)
              .map((memory) => ({ ...memory, shared: true }))
          : []),
      ],
      createMemory: (agentId, content, shared, context) => {
        if (!content.trim() || content.length > 32000)
          throw new AppError(400, "Memory must contain 1–32000 characters");
        assertOwnMemoryInGroup(context, shared);

        if (shared && !usesSharedMemory(agentId))
          throw new AppError(400, "Shared memory is off for this agent");

        return store.createMemory(
          {
            agentId: shared ? null : agentId,
            content,
            source: memorySourceOf(store, agentId, context),
          },
          undefined,
          memoryChangeBy(agentId, context),
        );
      },
      updateMemory: (agentId, id, content, context) => {
        const memory = reachableMemory(agentId, id);

        if (!memory) throw new AppError(404, "Memory not found");
        assertOwnMemoryInGroup(context, memory.agentId === null);

        if (!content.trim() || content.length > 32000)
          throw new AppError(400, "Memory must contain 1–32000 characters");

        return store.updateMemory(
          id,
          { content },
          memoryChangeBy(agentId, context),
        )!;
      },
      deleteMemory: (agentId, id, context) => {
        const memory = reachableMemory(agentId, id);

        if (!memory) throw new AppError(404, "Memory not found");
        assertOwnMemoryInGroup(context, memory.agentId === null);
        store.deleteMemory(id, memoryChangeBy(agentId, context));
      },
      skillLibrary: skillLibrary(store, commonSkills),
    });

    service = new CrumbleService(store, runtime);
    partialCleanup.push(() => service.close());

    const reviews = new LearningReview(store, runtime, (event) =>
      service.announce(event),
    );

    await reviews.recover();

    const stopReviews = service.onSettled((execution) =>
      reviews.afterExecution(execution),
    );

    partialCleanup.push(() => stopReviews());
    const curator = new SkillCurator(store);
    curator.start();
    partialCleanup.push(() => curator.stop());

    const stopJobAnswers = jobKinds.map((kind) =>
      kind.onAnswer((answer) => service.announceJobAnswer(answer)),
    );

    partialCleanup.push(() => {
      for (const stop of stopJobAnswers) stop();
    });

    const scheduler = new Scheduler(store, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    schedules = new BotSchedules(store, scheduler);
    partialCleanup.push(() => scheduler.stop());
    groupChats = new GroupChats(
      store,
      new GroupTranscripts(join(dataDir, "groups")),
      service,
    );
    partialCleanup.push(() => groupChats.close());
    historySearch = new HistorySearch(
      historySource(runtime, store, groupChats),
    );
    push = new PushManager(new PushStore(dataDir));
    push.attach(service);
    partialCleanup.push(() => push?.close());
    const token = randomBytes(32).toString("hex");

    const app = createAPI(
      service,
      scheduler,
      token,
      integrations,
      {
        commonSkills,
        coding: workspaces !== undefined,
        desktop: workspaces?.desktop === true,
        restartWorkspace: async (agentId) =>
          workspaces?.restart(agentId, BACKGROUND_CONTEXT),
        groupChats,
        desktopControl,
        viewerTickets: new ViewerTickets(),
        externalAuth: new Map(
          providers.flatMap(({ provider, externalAuth }) =>
            externalAuth ? [[provider.id, externalAuth] as const] : [],
          ),
        ),
        ...(workspaces && {
          openDesktop: (agentId: string) =>
            workspaces.openDesktop(agentId, BACKGROUND_CONTEXT),
        }),
        providerAuth,
        oauthClient,
      },
      push,
    );

    const awake = new Map<string, () => void>();

    const holdAwake = (agentId: string, state: ControlState) => {
      if (!workspaces) return;

      if (state.holder === "owner" && !awake.has(agentId))
        awake.set(agentId, workspaces.keepAwake(agentId));
      else if (state.holder === "bot") {
        awake.get(agentId)?.();
        awake.delete(agentId);
      }
    };

    desktopControl.subscribeAll(holdAwake);

    for (const agent of store.listAgents())
      holdAwake(agent.id, desktopControl.get(agent.id));
    await service.recover();
    await groupChats.recover();
    scheduler.start();
    let closed = false;

    return {
      app,
      token,
      service,
      scheduler,
      async close() {
        if (closed) return;
        closed = true;
        const errors: unknown[] = [];

        const attempt = async (action: () => Promise<void> | void) => {
          try {
            await action();
          } catch (error) {
            errors.push(error);
          }
        };

        await attempt(() => {
          for (const stop of stopJobAnswers) stop();
        });
        await attempt(() => stopReviews());
        await attempt(() => curator.stop());
        await attempt(() => scheduler.stop());
        await attempt(() => groupChats.close());
        await attempt(() => service.close());
        await attempt(() => workspaces?.close(BACKGROUND_CONTEXT));
        await attempt(() => push?.close());
        await attempt(() => integrations.close());
        await attempt(() => codemodeSandbox.close());
        await attempt(() => charts.close());
        await attempt(() => providerAuth?.close());
        await attempt(() => release());

        if (errors.length)
          throw new AggregateError(errors, "Tenant cleanup failed");
      },
    };
  } catch (error) {
    for (const cleanup of partialCleanup.reverse()) {
      try {
        await cleanup();
      } catch {
        /* preserve the startup error */
      }
    }

    await release();
    throw error;
  }
}
