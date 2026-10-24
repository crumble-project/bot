import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import path from "node:path";
import tls from "node:tls";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createEnvConformance } from "@earendil-works/pi-durable/testing";
import {
  Sandbox,
  SandboxNotFoundError,
  type SandboxCheckpointInfo,
  type SandboxTemplate,
} from "railway";
import {
  RailwayMachines,
  RailwayWorkspaces,
  railwayWorkspacesFromEnv,
} from "../src/railway-workspaces";
import { WORKSPACE_PATH } from "../src/workspace";
import { CredentialAuthorities } from "../src/credential-authority";
import { credentialProxy } from "../src/credential-proxy";
import { Credentials } from "../src/credentials";
import { Store } from "../src/store";

// Live tests create billed sandboxes, so they need an explicit opt-in besides the credentials.
const railwayTests =
  process.env.CRUMBLE_RAILWAY_TESTS === "1" &&
  Boolean(process.env.RAILWAY_TOKEN ?? process.env.RAILWAY_API_TOKEN);

// Checkpoint names are global to the Railway environment, so each run gets its own.
const namePrefix = `crumble-test-${process.pid}`;
const dataDir = mkdtempSync(path.join(tmpdir(), "crumble-railway-test-"));
const recordsDir = path.join(dataDir, "workspaces", "railway");

async function sh(env: ExecutionEnv, command: string) {
  let output = "";

  const result = await env.exec(
    command,
    { onOutput: (text) => (output += text) },
    BACKGROUND_CONTEXT,
  );

  assert(result.ok);

  return { exitCode: result.value.exitCode, output: output.trim() };
}

async function readText(env: ExecutionEnv, file: string) {
  const result = await env.readTextFile(file, BACKGROUND_CONTEXT);

  assert(result.ok, result.ok ? "" : result.error.message);

  return result.value;
}

const recordFile = (agentId: string) =>
  path.join(recordsDir, `${agentId}.json`);

const isRunning = (sandboxId: string) =>
  Sandbox.connect(sandboxId).then(
    (sandbox) => sandbox.status === "RUNNING",
    () => false,
  );

const readRecord = (agentId: string): { image: string; sandboxId?: string } =>
  JSON.parse(readFileSync(recordFile(agentId), "utf8"));

describe("Railway workspace configuration", () => {
  test("workspaces are unavailable unless Railway is the backend", () => {
    expect(railwayWorkspacesFromEnv({}, { dataDir })).toBeUndefined();
    expect(
      railwayWorkspacesFromEnv(
        { CRUMBLE_WORKSPACE_BACKEND: "railway" },
        { dataDir },
      ),
    ).toBeInstanceOf(RailwayWorkspaces);
  });

  test("desktop bots boot the desktop image", () => {
    const workspaces = new RailwayWorkspaces({
      dataDir,
      wantsDesktop: (agentId) => agentId === "desk",
    });

    expect(workspaces.desktop).toBe(true);
    expect(workspaces.imageFor("desk")).toStartWith("railway-desktop-");
    expect(workspaces.imageFor("plain")).toStartWith("railway-base-");
  });

  test("without the desktop no bot gets a bot desktop", () => {
    const workspaces = new RailwayWorkspaces({
      dataDir,
      desktop: false,
      wantsDesktop: () => true,
    });

    expect(workspaces.desktop).toBe(false);
    expect(workspaces.imageFor("desk")).toStartWith("railway-base-");
  });

  test("agent ids cannot name another machine", () => {
    const workspaces = new RailwayWorkspaces({ dataDir });

    for (const agentId of ["", "../other", "a/b", "x".repeat(65)])
      expect(() => workspaces.env(agentId)).toThrow("Invalid agent id");
  });
});

describe("Railway machines when Railway fails", () => {
  const fakeSandbox = (id: string) => {
    const fake = { destroyed: 0 };

    // Own properties shadow the SDK's getters and methods, so nothing reaches Railway.
    const sandbox: Sandbox = Object.create(Sandbox.prototype, {
      id: { value: id },
      status: { value: "RUNNING" },
      files: { value: { write: async () => undefined } },
      refresh: { value: async () => sandbox, writable: true },
      heartbeat: { value: async () => sandbox },
      exec: { value: async () => ({ exitCode: 0, stdout: "", stderr: "" }) },
      checkpoint: { value: async () => undefined },
      destroy: { value: async () => void (fake.destroyed += 1) },
    });

    return Object.assign(fake, { sandbox });
  };

  const stubSandboxes = (sandbox: Sandbox) => {
    const recipe: SandboxTemplate = Object.getPrototypeOf(Sandbox.template());

    spyOn(recipe, "build").mockImplementation(async function (
      this: SandboxTemplate,
    ) {
      return this;
    });

    return spyOn(Sandbox, "create").mockResolvedValue(sandbox);
  };

  const checkpointNamed = (key: string): SandboxCheckpointInfo => ({
    id: "checkpoint",
    key,
    environmentId: "test",
    createdAt: new Date(0).toISOString(),
  });

  const newMachines = (region?: string) => {
    const machineDir = mkdtempSync(path.join(tmpdir(), "crumble-railway-"));

    return {
      machineDir,
      machines: new RailwayMachines({
        dataDir: machineDir,
        desktop: false,
        ...(region && { region }),
      }),
    };
  };

  const writeMachineRecord = (
    machineDir: string,
    agentId: string,
    record: { image: string; sandboxId: string },
  ) => {
    const records = path.join(machineDir, "workspaces", "railway");

    mkdirSync(records, { recursive: true });
    writeFileSync(
      path.join(records, `${agentId}.json`),
      JSON.stringify(record),
    );
  };

  afterEach(() => {
    mock.restore();
  });

  test("a sandbox Railway cannot report on keeps running instead of being destroyed unsaved", async () => {
    const fake = fakeSandbox("live");
    stubSandboxes(fake.sandbox);
    const { machines } = newMachines();
    const machine = await machines.boot("bot", machines.baseImage);

    fake.sandbox.refresh = () =>
      Promise.reject(new Error("Railway is unreachable"));

    await expect(machine.stop()).rejects.toThrow("Railway is unreachable");
    expect(fake.destroyed).toBe(0);
  });

  test("a failed reconnect keeps the running sandbox instead of restoring an older checkpoint", async () => {
    const create = stubSandboxes(fakeSandbox("new").sandbox);
    const { machineDir, machines } = newMachines();
    const record = { image: machines.baseImage, sandboxId: "live" };

    writeMachineRecord(machineDir, "bot", record);
    spyOn(Sandbox, "connect").mockRejectedValue(
      new Error("Railway is unreachable"),
    );
    spyOn(Sandbox, "checkpoints").mockResolvedValue([
      checkpointNamed(machines.name("bot")),
    ]);

    await expect(machines.boot("bot", machines.baseImage)).rejects.toThrow(
      "Railway is unreachable",
    );
    expect(create).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        readFileSync(
          path.join(machineDir, "workspaces", "railway", "bot.json"),
          "utf8",
        ),
      ),
    ).toEqual(record);
  });

  test("new sandboxes boot in the configured region, and checkpoints where their data lives", async () => {
    const create = stubSandboxes(fakeSandbox("new").sandbox);
    const { machineDir, machines } = newMachines("europe-west4");

    await (await machines.boot("fresh", machines.baseImage)).stop();
    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.objectContaining({ region: "europe-west4" }),
    );

    writeMachineRecord(machineDir, "saved", {
      image: machines.baseImage,
      sandboxId: "gone",
    });
    spyOn(Sandbox, "connect").mockRejectedValue(
      new SandboxNotFoundError({ id: "gone", environmentId: "test" }),
    );
    spyOn(Sandbox, "checkpoints").mockResolvedValue([
      checkpointNamed(machines.name("saved")),
    ]);

    await (await machines.boot("saved", machines.baseImage)).stop();
    expect(create).toHaveBeenNthCalledWith(
      2,
      machines.name("saved"),
      expect.not.objectContaining({ region: expect.anything() }),
    );
  });
});

describe.skipIf(!railwayTests)("Railway sandbox workspaces", () => {
  const workspaces = new RailwayWorkspaces({ dataDir, namePrefix });

  afterAll(async () => {
    await workspaces.close();

    for (const file of readdirSync(recordsDir)) {
      const { sandboxId } = readRecord(path.basename(file, ".json"));

      if (sandboxId)
        await Sandbox.connect(sandboxId)
          .then((sandbox) => sandbox.destroy())
          .catch(() => undefined);
    }

    for (const checkpoint of await Sandbox.checkpoints())
      if (checkpoint.key.startsWith(`${namePrefix}-`))
        await Sandbox.deleteCheckpoint(checkpoint.id);
  }, 120_000);

  const env = () => workspaces.env("conformance");

  const cases = createEnvConformance({
    listFiles: true,
    assertions: {
      ok: (value, message) =>
        assert.ok(value, message ?? "expected a truthy value"),
      strictEqual: (actual, expected) => assert.strictEqual(actual, expected),
      deepEqual: (actual, expected) => assert.deepStrictEqual(actual, expected),
      partialDeepEqual: (actual, expected) =>
        assert.partialDeepStrictEqual(actual, expected),
      greaterThan: (actual, expected) =>
        assert.ok(actual > expected, `${actual} > ${expected}`),
      rejects: (operation, messageIncludes) =>
        assert.rejects(operation, (error) =>
          String(error instanceof Error ? error.message : error).includes(
            messageIncludes,
          ),
        ),
    },
    withEnv: async (use) => {
      await sh(env(), `find ${WORKSPACE_PATH} -mindepth 1 -delete`);
      await use(env());
    },
  });

  for (const conformance of cases)
    test(
      `env conformance: ${conformance.name}`,
      () => conformance.run(),
      conformance.timeoutMs ?? 120_000,
    );

  test("a job's credential placeholder reaches its host as the value, through the tunnel", async () => {
    const store = new Store(
      mkdtempSync(path.join(tmpdir(), "crumble-railway-credentials-")),
    );

    const agentInput = {
      avatar: "bot",
      description: "",
      instructions: "",
      provider: "faux",
      model: "chat",
      enabled: true,
      tools: ["coding"],
      skills: [],
      mcpServers: [],
      delegates: [],
    };

    const bot = store.createAgent({ ...agentInput, name: "bot" });

    const upstreamAgent = store.createAgent({
      ...agentInput,
      name: "upstream",
    });

    const authorities = new CredentialAuthorities(store);
    const credentials = new Credentials(store, async () => {});
    const value = "railway-live-test-value-0123456789";
    const seen: string[] = [];

    await credentials.save(bot.id, "ECHO_TOKEN", {
      hosts: ["example.com"],
      value,
    });

    // Stands in for example.com: the proxy checks the real name's public address, then dials this server instead.
    const upstream = tls.createServer(
      {
        SNICallback: (name, done) =>
          authorities
            .context(upstreamAgent.id, name)
            .then((context) => done(null, context), done),
      },
      (socket) => {
        let head = "";

        socket.on("data", (data: Buffer) => {
          head += data.toString("latin1");

          if (!head.includes("\r\n\r\n")) return;

          const authorization =
            /^authorization: (.*)$/im.exec(head)?.[1]?.trim() ?? "";

          seen.push(authorization);
          const body = JSON.stringify({ authorization });

          socket.end(
            `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`,
          );
        });
      },
    );

    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const upstreamCa = await authorities.certificate(upstreamAgent.id);
    // SAFETY: listen completed on a TCP port, not a Unix socket.
    const upstreamPort = (upstream.address() as AddressInfo).port;

    const workspaces = new RailwayWorkspaces({
      dataDir,
      namePrefix,
      caCertificate: (agentId) => authorities.certificate(agentId),
      intercept: (agentId) =>
        credentialProxy({
          agentId,
          authorities,
          grants: () => credentials.grants(agentId),
          recordUse: (name, use) => credentials.recordUse(agentId, name, use),
          lookup: async () => ["127.0.0.1"],
          isPublicAddress: () => true,
          upstreamCa,
        }),
    });

    try {
      const env = workspaces.env(bot.id, credentials.env(bot.id));
      const placeholder = store.agentCredentialPlaceholders(bot.id).ECHO_TOKEN!;
      const url = `https://example.com:${upstreamPort}/check`;

      const curl = await sh(
        env,
        `curl -sS --max-time 30 -H "Authorization: Bearer $ECHO_TOKEN" ${url}`,
      );

      const python = await sh(
        env,
        `python3 -c 'import os,urllib.request as u; print(u.urlopen(u.Request("${url}", headers={"Authorization": "Bearer "+os.environ["ECHO_TOKEN"]})).read().decode())'`,
      );

      const node = await sh(
        env,
        `node -e 'fetch("${url}",{headers:{authorization:"Bearer "+process.env.ECHO_TOKEN}}).then(r=>r.text()).then(console.log,e=>console.log("failed",e.cause?.message??e.message))'`,
      );

      for (const result of [curl, python, node]) {
        expect(result.output).toBe(
          JSON.stringify({ authorization: `Bearer ${placeholder}` }),
        );
      }

      expect(seen).toEqual(Array(3).fill(`Bearer ${value}`));
      expect(
        store.listCredentialUses(bot.id, "ECHO_TOKEN", { limit: 10 }),
      ).toHaveLength(3);
      expect((await sh(env, "env")).output).not.toContain(value);
    } finally {
      await workspaces.close();
      upstream.close();
      store.close();
    }
  }, 600_000);

  test("files survive a stop through the checkpoint", async () => {
    const first = new RailwayWorkspaces({ dataDir, namePrefix });

    await sh(first.env("persist"), "echo kept > /workspace/note");
    const { sandboxId } = readRecord("persist");
    await first.close();

    const second = new RailwayWorkspaces({ dataDir, namePrefix });

    try {
      expect(await readText(second.env("persist"), "/workspace/note")).toBe(
        "kept\n",
      );
      expect(readRecord("persist").sandboxId).not.toBe(sandboxId);
    } finally {
      await second.close();
    }
  }, 300_000);

  test("a server that died leaves its sandbox running for the next server", async () => {
    const module = path.join(import.meta.dir, "../src/railway-workspaces.ts");

    // Exits without close(): no checkpoint, the sandbox keeps running.
    const killed = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { RailwayWorkspaces } = await import(${JSON.stringify(module)});
         const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
         const workspaces = new RailwayWorkspaces({ dataDir: ${JSON.stringify(dataDir)}, namePrefix: ${JSON.stringify(namePrefix)} });
         const result = await workspaces.env("orphan").exec("echo unsynced > /workspace/note", {}, BACKGROUND_CONTEXT);
         process.exit(result.ok && result.value.exitCode === 0 ? 0 : 1);`,
      ],
      { cwd: path.join(import.meta.dir, ".."), stderr: "inherit" },
    );

    expect(await killed.exited).toBe(0);

    const { sandboxId } = readRecord("orphan");
    const next = new RailwayWorkspaces({ dataDir, namePrefix });

    try {
      expect(await readText(next.env("orphan"), "/workspace/note")).toBe(
        "unsynced\n",
      );
      expect(readRecord("orphan").sandboxId).toBe(sandboxId);
    } finally {
      await next.close();
    }
  }, 300_000);

  test("a synced workspace comes back from its checkpoint after Railway lost the sandbox", async () => {
    const lossy = new RailwayWorkspaces({
      dataDir,
      namePrefix,
      checkpointDelayMs: 500,
    });

    try {
      await sh(lossy.env("lost"), "echo kept > /workspace/note");
      await lossy.sync("lost");
      await Bun.sleep(20_000);

      const { sandboxId } = readRecord("lost");
      await (await Sandbox.connect(sandboxId!)).destroy();
      // A call in flight when the sandbox goes fails; the heartbeat notices within seconds and the next call boots.
      await Bun.sleep(15_000);

      expect(await readText(lossy.env("lost"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await lossy.close();
    }
  }, 300_000);

  test("an idle workspace stops and starts again with its files", async () => {
    const idle = new RailwayWorkspaces({
      dataDir,
      namePrefix,
      idleTimeoutMs: 500,
    });

    try {
      await sh(idle.env("idle"), "echo kept > /workspace/note");
      const { sandboxId } = readRecord("idle");
      await Bun.sleep(20_000);
      expect(await isRunning(sandboxId!)).toBe(false);

      expect(await readText(idle.env("idle"), "/workspace/note")).toBe(
        "kept\n",
      );
    } finally {
      await idle.close();
    }
  }, 300_000);

  test("a checkpoint of another image moves its workspace to the current one", async () => {
    const first = new RailwayWorkspaces({ dataDir, namePrefix });

    await sh(
      first.env("moved"),
      "mkdir -p /workspace/dir && echo kept > /workspace/dir/note",
    );
    await first.close();

    writeFileSync(
      recordFile("moved"),
      JSON.stringify({ ...readRecord("moved"), image: "railway-base-old" }),
    );

    const second = new RailwayWorkspaces({ dataDir, namePrefix });

    try {
      expect(await readText(second.env("moved"), "/workspace/dir/note")).toBe(
        "kept\n",
      );
      expect(readRecord("moved").image).toBe(second.imageFor("moved"));
    } finally {
      await second.close();
    }
  }, 600_000);
});
