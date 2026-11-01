import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, ManagedRuntime } from "effect";
import { productLayer } from "../app/product-layer";
import { AgentRepository } from "../bots/agent-repository";
import { ScheduleRepository } from "../schedules/schedule-repository";
import { agentInput, scheduleInput } from "../shared/domain";
import { EventRepository } from "./event-repository";
import { EVENT_BODY_LIMIT } from "./event-payload";
import { readPayload } from "./event-tools";

const ada = "00000000-0000-4000-8000-000000000001";
const grace = "00000000-0000-4000-8000-000000000002";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(body: Uint8Array) {
  const folder = mkdtempSync(join(tmpdir(), "crumble-event-tools-"));
  const runtime = ManagedRuntime.make(productLayer(folder));

  cleanups.push(async () => {
    await runtime.dispose();
    rmSync(folder, { recursive: true, force: true });
  });

  const events = await runtime.runPromise(
    Effect.gen(function* () {
      const agents = yield* AgentRepository;

      yield* agents.create(agentInput.parse({ name: "Ada" }), ada);
      yield* agents.create(agentInput.parse({ name: "Grace" }), grace);
      const repository = yield* EventRepository;

      yield* repository.addSource({
        id: "source-1",
        name: "GitHub",
        createdAt: "2026-11-01T00:00:00.000Z",
      });
      yield* (yield* ScheduleRepository).create(
        scheduleInput.parse({
          agentId: ada,
          name: "Triage",
          prompt: "Triage",
          eventSourceId: "source-1",
        }),
      );
      yield* repository.storeEvent({
        id: "01A",
        sourceId: "source-1",
        receivedAt: "2026-11-01T08:00:00.000Z",
        method: "POST",
        query: "",
        headers: [],
        body: Buffer.from(body).toString("base64"),
      });

      return repository;
    }),
  );

  return (agentId: string, offset?: number, limit?: number) =>
    Effect.runPromiseExit(
      readPayload(events, agentId, { eventId: "01A", offset, limit }),
    );
}

test("a bot pages through the body of an event its automation ran for", async () => {
  const read = await fixture(
    new TextEncoder().encode(`${"a".repeat(EVENT_BODY_LIMIT)}tail`),
  );

  const page = await read(ada, EVENT_BODY_LIMIT);

  expect(Exit.isSuccess(page) && page.value).toEqual({
    eventId: "01A",
    offset: EVENT_BODY_LIMIT,
    bytes: 4,
    totalBytes: EVENT_BODY_LIMIT + 4,
    encoding: "utf-8",
    data: "tail",
  });

  const first = await read(ada, 0, 10_000_000);

  expect(Exit.isSuccess(first) && first.value.bytes).toBe(EVENT_BODY_LIMIT);
});

test("another bot can't read the event", async () => {
  const read = await fixture(new TextEncoder().encode("secret"));
  const exit = await read(grace);

  expect(Exit.isFailure(exit) && String(exit.cause)).toContain(
    "Event not found",
  );
});

test("a slice that isn't UTF-8 comes back as base64", async () => {
  const read = await fixture(new Uint8Array([0xff, 0x00, 0x41]));
  const page = await read(ada);

  expect(Exit.isSuccess(page) && page.value).toMatchObject({
    encoding: "base64",
    data: Buffer.from([0xff, 0x00, 0x41]).toString("base64"),
    totalBytes: 3,
  });
});
