import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { Store } from "./store";
import { AgentRuntime } from "./runtime";
import { CrumbleService } from "./service";
import { Scheduler } from "./scheduler";
import { createAPI } from "./api";
import { AppError } from "./domain";
import { MCPIntegrations } from "./integrations";
import { coordinationExtension } from "./coordination";

export async function startServer(
  options: {
    dataDir?: string;
    hostname?: string;
    port?: number;
    token?: string;
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
  try {
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
    let service!: CrumbleService;
    const runtime = new AgentRuntime(join(dataDir, "agents"), {
      credentials: (provider) => store.getCredential(provider),
      currentAgent: (id) => store.getAgent(id),
      extensions: async (agent) => [
        ...(await integrations.extensionsForAgent(agent)),
        coordinationExtension(agent, service),
      ],
      listMemory: (agentId) => store.listMemories(agentId),
      createMemory: (agentId, content) => {
        if (!content.trim() || content.length > 32000)
          throw new AppError(400, "Memory must contain 1–32000 characters");
        return store.createMemory({ agentId, content });
      },
      updateMemory: (agentId, id, content) => {
        const memory = store.getMemory(id);
        if (!memory || memory.agentId !== agentId)
          throw new AppError(404, "Memory not found");
        if (!content.trim() || content.length > 32000)
          throw new AppError(400, "Memory must contain 1–32000 characters");
        return store.updateMemory(id, { content })!;
      },
      deleteMemory: (agentId, id) => {
        if (store.getMemory(id)?.agentId !== agentId)
          throw new AppError(404, "Memory not found");
        store.deleteMemory(id);
      },
    });
    service = new CrumbleService(store, runtime);
    const scheduler = new Scheduler(store, (a, p, r, s) =>
      service.dispatch(a, p, r, s),
    );
    const app = createAPI(service, scheduler, token, integrations);
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
        await integrations.close();
        await release();
      },
    };
  } catch (error) {
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
