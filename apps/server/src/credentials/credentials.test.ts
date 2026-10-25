import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Effect, Exit, Scope } from "effect";
import { BotNotices } from "../bots/bot-notices";
import { agentInput } from "../shared/domain";
import { Store } from "../shared/store";
import { Credentials } from "./credentials";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "crumble-credentials-"));
  dirs.push(dir);
  const store = new Store(dir);
  const agentId = store.createAgent(agentInput.parse({ name: "Bot" })).id;

  return { store, agentId };
}

type Notice = { agentId: string; text: string; requestId: string };

/** Takes the account's bot notices until the returned scope closes. */
function takeNotices(store: Store) {
  const notices: Notice[] = [];
  const scope = store.runtime.runSync(Scope.make());

  store.runtime.runSync(
    BotNotices.use((botNotices) =>
      botNotices.handle((agentId, text, requestId) =>
        Effect.sync(() => {
          notices.push({ agentId, text, requestId });
        }),
      ),
    ).pipe(Scope.provide(scope)),
  );

  return {
    notices,
    stop: () => store.runtime.runSync(Scope.close(scope, Exit.void)),
  };
}

const credentials = (store: Store) =>
  store.runtime.runSync(Credentials.use(Effect.succeed));

test("saving a requested credential answers the request with a notice to the bot", async () => {
  const { store, agentId } = open();
  const { notices, stop } = takeNotices(store);
  const service = credentials(store);

  await store.runtime.runPromise(
    service.request(agentId, {
      name: "ACME_TOKEN",
      hosts: ["api.acme.com"],
      reason: "Deploys",
    }),
  );
  await store.runtime.runPromise(
    service.save(agentId, "ACME_TOKEN", { value: "secret" }),
  );

  expect(notices).toEqual([
    {
      agentId,
      text: "The owner saved credential ACME_TOKEN for api.acme.com. Coding jobs see it as $ACME_TOKEN.",
      requestId: expect.stringMatching(/^credential:ACME_TOKEN:/),
    },
  ]);
  expect(store.listCredentialRequests(agentId)).toEqual([]);
  stop();
  store.close();
});

test("declining a request notifies the bot, and deleting a credential does not", async () => {
  const { store, agentId } = open();
  const { notices, stop } = takeNotices(store);
  const service = credentials(store);

  await store.runtime.runPromise(
    service.request(agentId, {
      name: "PENDING",
      hosts: ["example.com"],
      reason: "Tests",
    }),
  );
  await store.runtime.runPromise(service.delete(agentId, "PENDING"));
  await store.runtime.runPromise(
    service.save(agentId, "KEPT", { hosts: ["example.com"], value: "v" }),
  );
  await store.runtime.runPromise(service.delete(agentId, "KEPT"));

  expect(notices.map((notice) => notice.text)).toEqual([
    "The owner declined your request for credential PENDING.",
  ]);
  stop();
  store.close();
});

test("a save still succeeds when nothing takes notices", async () => {
  const { store, agentId } = open();
  const service = credentials(store);

  await store.runtime.runPromise(
    service.request(agentId, {
      name: "ACME_TOKEN",
      hosts: ["api.acme.com"],
      reason: "Deploys",
    }),
  );

  expect(
    (
      await store.runtime.runPromise(
        service.save(agentId, "ACME_TOKEN", { value: "secret" }),
      )
    ).name,
  ).toBe("ACME_TOKEN");
  store.close();
});
