import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect } from "effect";
import { desktopFillsAccess } from "./desktop-fill-repository";
import { desktopFills } from "./schema";
import { agentInput } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { Store } from "../../test/support/store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "bot-fills-"));

  dirs.push(dir);

  const store = new Store(dir);
  const agent = store.createAgent(agentInput.parse({ name: "Desk" }));

  return { store, agentId: agent.id };
}

const rows = (store: Store) =>
  store.run(
    ProductDatabase.use((db) => db.select().from(desktopFills)).pipe(
      Effect.orDie,
    ),
  );

const fill = {
  value: "hunter2",
  label: "[login github password]",
  browser: "7 Thu Oct 30 10:00:00 2026",
};

test("passwords are stored encrypted and listed with their Chromium", async () => {
  const { store, agentId } = open();
  const fills = desktopFillsAccess(store.runtime, agentId);

  await fills.add(fill);

  expect(rows(store).some((row) => row.value.includes("hunter2"))).toBe(false);
  expect(await fills.list()).toEqual([fill]);
  store.close();
});

test("a bot's fills go with the bot", async () => {
  const { store, agentId } = open();

  await desktopFillsAccess(store.runtime, agentId).add(fill);
  store.deleteAgent(agentId);

  expect(rows(store)).toEqual([]);
  store.close();
});
