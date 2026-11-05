import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { SkillCurator, skillCuration } from "./skill-curator";
import { curateNow } from "./skill-curator-test-support";
import { Store } from "../../test/support/store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

test("stale and archive bot-created skills by idle time, sparing pinned, scheduled, and owner-written ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-curator-"));
  dirs.push(dir);
  const store = new Store(dir);

  const agent = store.createAgent({
    name: "A",
    description: "",
    instructions: "x",
    provider: "openai",
    model: "gpt-4.1",
    enabled: true,
    tools: [],
    skills: [{ name: "Owner written", instructions: "Kept forever" }],
    mcpServers: [],
    delegates: [],
  });

  const now = new Date("2026-10-23T12:00:00Z");
  const db = new Database(join(dir, "store.sqlite"));

  const daysAgo = (days: number) =>
    new Date(now.getTime() - days * DAY).toISOString();

  const bot = (
    name: string,
    patch: { lastUsedAt?: string | null; useCount?: number; pinned?: boolean },
  ) => {
    const skill = store.createSkill(
      {
        agentId: agent.id,
        name,
        description: "",
        instructions: "Learned",
        documents: [],
        createdBy: "bot",
      },
      undefined,
      null,
    );

    store.updateSkill(skill.id, { ...patch }, null);
    db.query("UPDATE skills SET updated_at=?, created_at=? WHERE id=?").run(
      daysAgo(100),
      patch.lastUsedAt ? daysAgo(100) : daysAgo(3),
      skill.id,
    );

    return skill.id;
  };

  const fresh = bot("Fresh", { lastUsedAt: daysAgo(3), useCount: 2 });
  const idle = bot("Idle", { lastUsedAt: daysAgo(15), useCount: 2 });
  const old = bot("Old", { lastUsedAt: daysAgo(31), useCount: 2 });

  const pinned = bot("Pinned", {
    lastUsedAt: daysAgo(90),
    useCount: 2,
    pinned: true,
  });

  const scheduled = bot("Report digest", {
    lastUsedAt: daysAgo(90),
    useCount: 2,
  });

  const neverUsed = bot("Never used", { lastUsedAt: null, useCount: 0 });

  store.createSchedule({
    agentId: agent.id,
    name: "Weekly",
    kind: "prompt",
    command: null,
    timeoutSeconds: 600,
    notify: true,
    prompt: "Use the Report Digest skill every Monday",
    cron: null,
    timezone: "UTC",
    runAt: null,
    eventSourceId: null,
    enabled: true,
  });

  const actions = curateNow(store, now);

  expect(
    actions.map((action) => [action.name, action.from, action.to]),
  ).toEqual([
    ["Idle", "active", "stale"],
    ["Old", "active", "archived"],
  ]);
  expect(store.getSkill(fresh)?.state).toBe("active");
  expect(store.getSkill(pinned)?.state).toBe("active");
  expect(store.getSkill(scheduled)?.state).toBe("active");
  expect(store.getSkill(neverUsed)?.state).toBe("active");
  expect(
    store.listSkills(agent.id).find((skill) => skill.name === "Owner written")
      ?.state,
  ).toBe("active");

  expect(
    store.listChanges(agent.id).filter((change) => change.actor === "curator"),
  ).toHaveLength(2);
  expect(curateNow(store, now)).toEqual([]);

  store.recordSkillUse(idle);
  expect(store.getSkill(idle)?.state).toBe("active");
  store.updateSkill(old, { state: "active" });
  expect(store.getSkill(old)).toMatchObject({ state: "active", pinned: false });
  expect(curateNow(store, now)).toEqual([]);
  expect(store.getSkill(old)?.state).toBe("active");

  const later = new Date(now.getTime() + 31 * DAY);
  expect(
    curateNow(store, later).map((action) => [action.name, action.to]),
  ).toContainEqual(["Never used", "archived"]);
  db.close();
  store.close();
});

test("curation runs a pass at start and every six hours, and stops with its scope", async () => {
  const passes: number[] = [];

  const curator = Layer.succeed(SkillCurator, {
    pass: (now) =>
      Effect.sync(() => {
        passes.push(now.getTime());

        return [];
      }),
  });

  const runtime = ManagedRuntime.make(
    skillCuration.pipe(
      Layer.provide(curator),
      Layer.provideMerge(TestClock.layer()),
    ),
  );

  await runtime.runPromise(TestClock.adjust("1 second"));
  expect(passes).toHaveLength(1);
  await runtime.runPromise(TestClock.adjust("6 hours"));
  expect(passes).toHaveLength(2);
  expect(passes[1]! - passes[0]!).toBe(6 * 60 * 60 * 1000);

  await runtime.dispose();
  expect(passes).toHaveLength(2);
});
