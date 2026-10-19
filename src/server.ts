import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import lockfile from "proper-lockfile";
import { Store } from "./store";
import { AgentRuntime } from "./runtime";
import { CrumbleService, OWNER_TIMEZONE } from "./service";
import { Scheduler } from "./scheduler";
import { createAPI } from "./api";
import { AppError, type Agent } from "./domain";
import { MCPIntegrations } from "./integrations";
import { BotSchedules, scheduleExtension } from "./bot-schedules";
import { coordinationExtension } from "./coordination";
import { ChartCompiler } from "./charts";
import { displayExtension } from "./display";
import { reactionExtension } from "./reaction";
import { codingEnv, codingExtensions } from "./coding";
import type { Workspaces } from "./workspace";
import { microsandboxWorkspacesFromEnv } from "./microsandbox-workspaces";
import { CodemodeSandbox } from "@earendil-works/pi-codemode";
import { createCodemodeExtension } from "@earendil-works/pi-durable/codemode";
import { loadCommonSkills } from "./common-skills";
import { PushManager, PushStore } from "./push";

export async function startServer(
  options: {
    dataDir?: string;
    hostname?: string;
    port?: number;
    token?: string;
    skillsDir?: string;
    /**
     * Backs the `coding` tool; defaults to Microsandbox workspaces when `CRUMBLE_WORKSPACE_IMAGE` is set. Without it no bot
     * is offered the tool. The server closes it on shutdown.
     */
    workspaces?: Workspaces;
  } = {},
) {
  const dataDir = resolve(
    options.dataDir ?? process.env.CRUMBLE_DATA_DIR ?? "./data",
  );

  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);

  const release = await lockfile.lock(dataDir, {
    stale: 30000,
    update: 10000,
    retries: 0,
  });

  let push: PushManager | undefined;

  try {
    const explicitSkillsDir =
      options.skillsDir ?? process.env.CRUMBLE_SKILLS_DIR;

    const skillsDir = resolve(
      // `skills` is part of the workspace next to bot; import.meta.dir keeps
      // this independent of the process working directory.
      explicitSkillsDir ?? resolve(import.meta.dir, "../../skills"),
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
    const tokenFile = join(dataDir, "server-token");

    if (!existsSync(tokenFile))
      writeFileSync(tokenFile, randomBytes(32).toString("hex"), {
        mode: 0o600,
        flag: "wx",
      });
    chmodSync(tokenFile, 0o600);

    const token =
      options.token ??
      process.env.CRUMBLE_TOKEN ??
      readFileSync(tokenFile, "utf8").trim();

    const store = new Store(dataDir);
    const integrations = new MCPIntegrations(store);

    // One sandbox runs every agent's code mode scripts, each in a worker of its own.
    const codemodeSandbox = new CodemodeSandbox({
      memoryLimitBytes: 256 * 1024 * 1024,
    });

    const charts = new ChartCompiler();

    const usesSharedMemory = (agentId: string) =>
      store.getAgent(agentId)?.sharedMemory === true;

    // A bot reaches its own memories, and the shared ones while it uses shared memory.
    const reachableMemory = (agentId: string, id: string) => {
      const memory = store.getMemory(id);

      return memory?.agentId === agentId ||
        (memory?.agentId === null && usesSharedMemory(agentId))
        ? memory
        : null;
    };

    const workspaces = options.workspaces ?? microsandboxWorkspacesFromEnv();

    const coding = (agent: Agent) =>
      workspaces && agent.tools.includes("coding")
        ? codingExtensions(agent, workspaces)
        : { chat: [], job: [] };

    let service!: CrumbleService;
    let schedules!: BotSchedules;

    const runtime = new AgentRuntime(join(dataDir, "agents"), {
      commonSkills: () => commonSkills,
      credentials: (provider) => store.getCredential(provider),
      currentAgent: (id) => store.getAgent(id),
      ownerTimezone: () => store.getSetting<string>(OWNER_TIMEZONE),
      extensions: async (agent) => [
        ...(await integrations.extensionsForAgent(agent)),
        coordinationExtension(agent, service),
        scheduleExtension(agent, schedules),
        displayExtension(charts),
        reactionExtension(),
        ...coding(agent).chat,
        ...(agent.tools.includes("codemode")
          ? [
              createCodemodeExtension({
                sandbox: codemodeSandbox,
                namespaces: integrations.codemodeNamespaces(agent),
              }),
            ]
          : []),
      ],
      taskExtensions: (agent) => coding(agent).job,
      env: (agentId, target, context) =>
        workspaces
          ? codingEnv(workspaces, agentId, target, context)
          : undefined,
      listMemory: (agentId) => [
        ...store.listMemories(agentId),
        ...(usesSharedMemory(agentId)
          ? store
              .listMemories(null)
              .map((memory) => ({ ...memory, shared: true }))
          : []),
      ],
      createMemory: (agentId, content, shared) => {
        if (!content.trim() || content.length > 32000)
          throw new AppError(400, "Memory must contain 1–32000 characters");

        if (shared && !usesSharedMemory(agentId))
          throw new AppError(400, "Shared memory is off for this agent");

        return store.createMemory({
          agentId: shared ? null : agentId,
          content,
        });
      },
      updateMemory: (agentId, id, content) => {
        if (!reachableMemory(agentId, id))
          throw new AppError(404, "Memory not found");

        if (!content.trim() || content.length > 32000)
          throw new AppError(400, "Memory must contain 1–32000 characters");

        return store.updateMemory(id, { content })!;
      },
      deleteMemory: (agentId, id) => {
        if (!reachableMemory(agentId, id))
          throw new AppError(404, "Memory not found");
        store.deleteMemory(id);
      },
      sharedSkills: (agent) =>
        (agent.sharedSkills ?? []).flatMap((id) => {
          const skill = store.getSkill(id);

          return skill
            ? [{ name: skill.name, instructions: skill.instructions }]
            : [];
        }),
    });

    service = new CrumbleService(store, runtime);

    const scheduler = new Scheduler(store, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );

    schedules = new BotSchedules(store, scheduler);
    push = new PushManager(new PushStore(dataDir));
    push.attach(service);

    const app = createAPI(
      service,
      scheduler,
      token,
      integrations,
      {
        commonSkills,
        coding: workspaces !== undefined,
      },
      push,
    );

    const server = Bun.serve({
      fetch: app.fetch,
      hostname: options.hostname ?? process.env.CRUMBLE_HOST ?? "127.0.0.1",
      port: options.port ?? Number(process.env.CRUMBLE_PORT ?? 7337),
      idleTimeout: 60,
    });

    await service.recover();
    scheduler.start();
    let closed = false;

    return {
      server,
      service,
      scheduler,
      tokenFile,
      async close() {
        if (closed) return;
        closed = true;
        await scheduler.stop();
        await server.stop(true);
        await service.close();
        await workspaces?.close(BACKGROUND_CONTEXT);
        await push?.close();
        await integrations.close();
        await codemodeSandbox.close();
        await charts.close();
        await release();
      },
    };
  } catch (error) {
    await push?.close();
    await release();
    throw error;
  }
}

if (import.meta.main) {
  const running = await startServer();
  console.log(`Crumble server listening on ${running.server.url}`);
  console.log(
    `Connection token: ${running.tokenFile} (copy its contents into the macOS app)`,
  );

  const close = async () => {
    await running.close();
    process.exit(0);
  };

  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
