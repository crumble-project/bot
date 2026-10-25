import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { desktopControlAccess } from "./desktop-control";
import { DesktopControlRepository } from "./desktop-control-repository";
import { agentInput } from "../shared/domain";
import { Store } from "../shared/store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "bot-control-"));

  dirs.push(dir);

  const store = new Store(dir);
  const agent = store.createAgent(agentInput.parse({ name: "Desk" }));

  return { dir, store, agentId: agent.id };
}

test("the bot holds control until the owner takes it, and every change counts", () => {
  const { store, agentId } = open();
  const control = desktopControlAccess(store.runtime);

  expect(control.get(agentId)).toMatchObject({ holder: "bot", changes: 0 });
  expect(control.set(agentId, "owner")).toMatchObject({
    holder: "owner",
    changes: 1,
  });

  // Setting the current holder again changes nothing.
  expect(control.set(agentId, "owner")).toMatchObject({
    holder: "owner",
    changes: 1,
  });
  expect(control.set(agentId, "bot")).toMatchObject({
    holder: "bot",
    changes: 2,
  });
  store.close();
});

test("the lease survives a restart", () => {
  const { dir, store, agentId } = open();

  desktopControlAccess(store.runtime).set(agentId, "owner");
  store.close();

  const reopened = new Store(dir);

  expect(desktopControlAccess(reopened.runtime).get(agentId)).toMatchObject({
    holder: "owner",
    changes: 1,
  });
  reopened.close();
});

test("waiting for the bot's turn resolves on hand-back, and listeners hear each change", async () => {
  const { store, agentId } = open();
  const control = desktopControlAccess(store.runtime);
  const heard: string[] = [];
  const stop = control.subscribe(agentId, (state) => heard.push(state.holder));

  control.set(agentId, "owner");

  let resolved = false;

  const waiting = control
    .untilBot(agentId, BACKGROUND_CONTEXT)
    .then(() => (resolved = true));

  await Bun.sleep(50);
  expect(resolved).toBe(false);

  control.set(agentId, "bot");
  await waiting;
  expect(heard).toEqual(["owner", "bot"]);
  stop();
  store.close();
});

test("deleting a bot deletes its lease", () => {
  const { store, agentId } = open();

  desktopControlAccess(store.runtime).set(agentId, "owner");
  store.deleteAgent(agentId);
  expect(
    store.runtime.runSync(
      DesktopControlRepository.use((repository) => repository.get(agentId)),
    ),
  ).toBeNull();
  store.close();
});
