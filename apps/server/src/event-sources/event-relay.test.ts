import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { productLayer } from "../app/product-layer";
import { AgentRepository } from "../bots/agent-repository";
import { SecretRepository } from "../credentials/secret-repository";
import { PasswordManagers } from "../password-managers/password-manager";
import { SecretValues } from "../password-managers/secret-values";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { agentInput, scheduleInput } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { schedules } from "../schedules/schema";
import { EventRepository } from "./event-repository";
import { EventRelay, RELAY_TOKEN_KEY } from "./event-relay";
import { EventSources } from "./event-sources";
import { relayEvents } from "./schema";
import { eq } from "drizzle-orm";
import { consumerMessage, type EventMessage } from "@doorstep/protocol";

const TOKEN = "account-token";
const ada = "00000000-0000-4000-8000-000000000001";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const event = (id: string): EventMessage => ({
  type: "event",
  id,
  sourceId: "source-1",
  receivedAt: "2026-11-01T08:00:00.000Z",
  method: "POST",
  query: "a=1",
  headers: [["content-type", "application/json"]],
  body: Buffer.from('{"action":"opened"}').toString("base64"),
});

/** A Doorstep relay that greets with `protocol`, records acks, and serves the sources API. */
function fakeRelay(protocol = 1) {
  const acks: string[] = [];
  const authorizations: (string | null)[] = [];
  const deleted: string[] = [];
  const sockets = new Set<ServerWebSocket<unknown>>();
  let sources = 0;

  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      const authorization = request.headers.get("authorization");
      authorizations.push(authorization);

      if (authorization !== `Bearer ${TOKEN}`)
        return new Response("Unauthorized", { status: 401 });

      if (url.pathname === "/v1/connect")
        return server.upgrade(request)
          ? undefined
          : new Response("Upgrade failed", { status: 400 });

      if (url.pathname === "/v1/sources" && request.method === "POST") {
        const id = `source-${++sources}`;

        return Response.json(
          { id, url: `${url.origin}/h/account/${id}-secret` },
          { status: 201 },
        );
      }

      const match = /^\/v1\/sources\/(.+)$/.exec(url.pathname);

      if (match && request.method === "DELETE") {
        deleted.push(decodeURIComponent(match[1]!));

        return new Response(null, { status: 204 });
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        sockets.add(socket);
        socket.send(
          JSON.stringify({ type: "hello", protocol, accountId: "account" }),
        );
      },
      message(_socket, message) {
        const ack = consumerMessage.safeParse(JSON.parse(String(message)));

        if (ack.success) acks.push(ack.data.id);
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });

  cleanups.push(() => server.stop(true));

  return {
    url: server.url.origin,
    acks,
    authorizations,
    deleted,
    send: (message: EventMessage) => {
      for (const socket of sockets) socket.send(JSON.stringify(message));
    },
    drop: () => {
      for (const socket of sockets) socket.close();
    },
    connections: () => sockets.size,
  };
}

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3000;

  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await Bun.sleep(5);
  }
}

async function fixture() {
  const folder = mkdtempSync(join(tmpdir(), "crumble-event-relay-"));

  const runtime = ManagedRuntime.make(
    EventSources.layer.pipe(
      Layer.provideMerge(EventRelay.layer),
      Layer.provideMerge(
        SecretValues.layer.pipe(Layer.provideMerge(PasswordManagers.layer([]))),
      ),
      Layer.provideMerge(productLayer(folder)),
      Layer.provideMerge(TestClock.layer()),
    ),
  );

  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(folder, { recursive: true, force: true });
  });

  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      | EventSources
      | EventRelay
      | EventRepository
      | SecretRepository
      | ScheduleRepository
      | AgentRepository
      | ProductDatabase
    >,
  ) => runtime.runPromise(effect);

  const tick = () => run(EventRelay.use((relay) => relay.tick));

  const status = () => run(EventRelay.use((relay) => relay.status));

  const configure = async (
    url: string | null,
    token: string | null = TOKEN,
  ) => {
    if (token)
      await run(SecretRepository.use((s) => s.set(RELAY_TOKEN_KEY, token)));
    await run(EventSources.use((sources) => sources.setRelayUrl(url)));
  };

  const storedEvents = () =>
    run(
      ProductDatabase.use((db) =>
        db.select().from(relayEvents).pipe(Effect.orDie),
      ),
    );

  return { runtime, run, tick, status, configure, storedEvents };
}

test("the relay connects with the account token, stores each event once, and acks it", async () => {
  const relay = fakeRelay();
  const { configure, status, storedEvents, run } = await fixture();

  await configure(relay.url);
  await until(async () => (await status()).status === "connected");
  expect(relay.authorizations).toContain(`Bearer ${TOKEN}`);

  relay.send(event("01A"));
  await until(() => relay.acks.includes("01A"));
  relay.send(event("01A"));
  await until(() => relay.acks.length === 2);

  expect(relay.acks).toEqual(["01A", "01A"]);
  expect(await storedEvents()).toHaveLength(1);
  expect(
    await run(EventRepository.use((events) => events.getEvent("01A"))),
  ).toEqual({
    id: "01A",
    sourceId: "source-1",
    receivedAt: "2026-11-01T08:00:00.000Z",
    method: "POST",
    query: "a=1",
    headers: [["content-type", "application/json"]],
    body: Buffer.from('{"action":"opened"}').toString("base64"),
  });
  expect(await status()).toEqual({
    url: relay.url,
    tokenConfigured: true,
    status: "connected",
    error: null,
  });
});

test("a relay speaking another protocol stops the connection until the settings change", async () => {
  const relay = fakeRelay(2);
  const { configure, status, tick } = await fixture();

  await configure(relay.url);
  await until(
    async () =>
      (await status()).error ===
      "The relay speaks protocol 2; this server needs 1.",
  );
  await until(() => relay.connections() === 0);
  const attempts = relay.authorizations.length;

  await tick();
  await Bun.sleep(50);
  expect(relay.authorizations).toHaveLength(attempts);

  await configure(`${relay.url}/`);
  await until(() => relay.authorizations.length > attempts);
});

test("a dropped connection reconnects only after the reconnect delay", async () => {
  const relay = fakeRelay();
  const { configure, status, tick, run } = await fixture();

  await configure(relay.url);
  await until(async () => (await status()).status === "connected");
  relay.drop();
  await until(async () => (await status()).status === "error");
  expect((await status()).error).toBe(
    "Lost the connection to the event relay. Reconnecting automatically.",
  );

  await tick();
  await Bun.sleep(50);
  expect(relay.connections()).toBe(0);

  await run(TestClock.adjust("61 seconds"));
  await tick();
  await until(async () => (await status()).status === "connected");
});

test("the relay status explains a missing URL or token", async () => {
  const { configure, status } = await fixture();

  expect(await status()).toEqual({
    url: null,
    tokenConfigured: false,
    status: "disconnected",
    error: null,
  });

  await configure("http://127.0.0.1:9", null);
  expect(await status()).toEqual({
    url: "http://127.0.0.1:9",
    tokenConfigured: false,
    status: "error",
    error: "Configure the Doorstep account token.",
  });
});

test("event sources are created and deleted on the relay, and kept while an automation uses them", async () => {
  const relay = fakeRelay();
  const { configure, run } = await fixture();

  await configure(relay.url);

  const created = await run(
    EventSources.use((sources) => sources.create("GitHub crumble")),
  );

  expect(created).toMatchObject({
    id: "source-1",
    name: "GitHub crumble",
    usedBy: 0,
    address: `${relay.url}/h/account/source-1-secret`,
  });
  expect(await run(EventSources.use((sources) => sources.list))).toEqual([
    {
      id: "source-1",
      name: "GitHub crumble",
      createdAt: created.createdAt,
      usedBy: 0,
    },
  ]);

  await run(
    Effect.gen(function* () {
      yield* (yield* AgentRepository).create(
        agentInput.parse({ name: "Ada" }),
        ada,
      );

      const schedule = yield* (yield* ScheduleRepository).create(
        scheduleInput.parse({
          agentId: ada,
          name: "Triage",
          prompt: "Triage the issue",
          cron: "0 9 * * *",
        }),
      );

      yield* ProductDatabase.use((db) =>
        db
          .update(schedules)
          .set({ eventSourceId: "source-1" })
          .where(eq(schedules.id, schedule.id))
          .pipe(Effect.orDie),
      );
    }),
  );

  const refused = await run(
    EventSources.use((sources) => sources.remove("source-1")).pipe(Effect.exit),
  );

  expect(Exit.isFailure(refused) && String(refused.cause)).toContain(
    "Used by 1 automation",
  );
  expect(relay.deleted).toEqual([]);

  await run(
    ProductDatabase.use((db) =>
      db.update(schedules).set({ eventSourceId: null }).pipe(Effect.orDie),
    ),
  );
  await run(EventSources.use((sources) => sources.remove("source-1")));
  expect(relay.deleted).toEqual(["source-1"]);
  expect(await run(EventSources.use((sources) => sources.list))).toEqual([]);
});

test("creating a source explains a rejected token", async () => {
  const relay = fakeRelay();
  const { configure, run } = await fixture();

  await configure(relay.url, "wrong-token");

  const exit = await run(
    EventSources.use((sources) => sources.create("GitHub")).pipe(Effect.exit),
  );

  expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
    "The relay rejected the account token",
  );
});
