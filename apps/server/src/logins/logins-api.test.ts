import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../test/support/store";
import { handleApiError } from "../app/api";
import { contractApp } from "../contract/api-contract";
import {
  loginResponse,
  loginsResponse,
  loginUseResponse,
} from "../contract/api-responses";
import { agentInput, type LoginSaveInput } from "../shared/domain";
import { NotFound } from "../shared/errors";
import { loginsAccess } from "./logins";
import { registerLoginRoutes } from "./logins-api";

const PASSWORD = "correct horse battery staple";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "crumble-logins-api-"));
  const store = new Store(dir);
  const agentId = store.createAgent(agentInput.parse({ name: "Bot" })).id;
  const logins = loginsAccess(store.runtime);
  const app = contractApp();

  cleanups.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  app.onError(handleApiError);
  registerLoginRoutes({
    register: (definition, handler) =>
      app.on(definition.method, definition.getRoutingPath(), handler),
    service: {
      agent: (id) => {
        if (id !== agentId) throw new NotFound({ message: "Bot not found" });

        return store.getAgent(id)!;
      },
    },
    logins,
  });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(`/v1/agents/${agentId}/logins${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });

  const save = (name: string, body: LoginSaveInput) =>
    request(`/${name}`, { method: "PUT", body: JSON.stringify(body) });

  return { app, agentId, logins, request, save };
};

const github = {
  hosts: ["github.com"],
  fields: {
    username: { value: "ada@example.com" },
    password: { value: PASSWORD },
  },
};

test("a saved login is listed with where its fields come from, never their values", async () => {
  const api = setup();

  const saved = await api.save("github", github);
  const savedText = await saved.text();

  expect(saved.status).toBe(200);
  expect(savedText).not.toContain(PASSWORD);
  expect(loginResponse.parse(JSON.parse(savedText))).toMatchObject({
    name: "github",
    hosts: ["github.com"],
    fields: {
      username: { passwordManager: null, reference: null },
      password: { passwordManager: null, reference: null },
    },
    lastUsedAt: null,
    lastError: null,
  });

  const listed = await (await api.request("")).text();

  expect(listed).not.toContain(PASSWORD);
  expect(listed).not.toContain("ada@example.com");
  expect(
    loginsResponse.parse(JSON.parse(listed)).logins.map((login) => login.name),
  ).toEqual(["github"]);
});

test("an invalid login is rejected with its reason", async () => {
  const api = setup();

  const response = await api.save("github", {
    hosts: ["github.com"],
    fields: { username: { value: "ada" } },
  });

  expect(response.status).toBe(400);
  expect(await response.text()).toContain(
    "A login needs a username and a password",
  );
});

test("deleting a login answers 204, and an unknown one 404", async () => {
  const api = setup();

  await api.save("github", github);

  expect((await api.request("/github", { method: "DELETE" })).status).toBe(204);
  expect((await api.request("/github", { method: "DELETE" })).status).toBe(404);
  expect(loginsResponse.parse(await (await api.request("")).json())).toEqual({
    logins: [],
    requests: [],
  });
});

test("a login's fills are listed newest first and paged with before", async () => {
  const api = setup();

  await api.save("github", github);
  api.logins.recordUse(api.agentId, "github", {
    at: "2026-10-30T10:00:00.000Z",
    host: "github.com",
    field: "username",
    error: null,
  });
  api.logins.recordUse(api.agentId, "github", {
    at: "2026-10-30T10:00:01.000Z",
    host: "github.com",
    field: "password",
    error: "1Password could not be reached",
  });

  const uses = loginUseResponse
    .array()
    .parse(await (await api.request("/github/uses")).json());

  expect(uses.map((use) => use.field)).toEqual(["password", "username"]);
  expect(uses[0]!.error).toBe("1Password could not be reached");

  const older = loginUseResponse
    .array()
    .parse(
      await (
        await api.request(`/github/uses?limit=1&before=${uses[0]!.id}`)
      ).json(),
    );

  expect(older.map((use) => use.field)).toEqual(["username"]);
});

test("a bot that doesn't exist answers 404", async () => {
  const api = setup();

  expect((await api.app.request("/v1/agents/nobody/logins")).status).toBe(404);
});

test("a request is listed, and declining it answers 204 once", async () => {
  const api = setup();

  api.logins.request(api.agentId, {
    name: "github",
    hosts: ["github.com"],
    reason: "To read private issues",
  });

  expect(
    loginsResponse.parse(await (await api.request("")).json()).requests,
  ).toMatchObject([
    { name: "github", hosts: ["github.com"], oneTimeCode: false },
  ]);
  expect(
    (await api.request("/github/decline", { method: "POST" })).status,
  ).toBe(204);
  expect(
    (await api.request("/github/decline", { method: "POST" })).status,
  ).toBe(409);
});
