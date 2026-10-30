import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Context, Effect, Exit, Layer, Option, Redacted, Scope } from "effect";
import type { CoreServices } from "../app/core-layer";
import { PasswordManagers } from "../password-managers/password-manager";
import { PasswordManagerRepository } from "../password-managers/password-manager-repository";
import { SecretValues } from "../password-managers/secret-values";
import { agentInput, loginSaveInput } from "../shared/domain";
import { runnerOf } from "../shared/runner";
import {
  FAKE_TOKEN,
  fakePasswordManager,
  fakeVendor,
  type FakePasswordManager,
} from "../../test/support/fake-password-manager";
import { takeNotices } from "../../test/support/notices";
import { Store } from "../../test/support/store";
import { Logins } from "./logins";
import { oneTimeCode, parseOneTimeSecret } from "./one-time-codes";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const ITEM = "op://Vault/GitHub";

/** A bot's logins over a fake 1Password holding `values`, connected with its token. */
function open(values: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "crumble-logins-"));
  dirs.push(dir);
  const store = new Store(dir);
  const agentId = store.createAgent(agentInput.parse({ name: "Bot" })).id;
  const state: FakePasswordManager = fakePasswordManager(values);
  const core = store.run(Effect.context<CoreServices>());
  const scope = Scope.makeUnsafe();

  const context = Effect.runSync(
    Layer.buildWithScope(
      Logins.layer.pipe(
        Layer.provideMerge(
          SecretValues.layer.pipe(
            Layer.provideMerge(PasswordManagers.layer([fakeVendor(state)])),
          ),
        ),
        Layer.provide(Layer.succeedContext(core)),
      ),
      scope,
    ),
  );

  store.run(
    PasswordManagerRepository.use((repository) =>
      repository.save("1password", Redacted.make(FAKE_TOKEN), "t"),
    ),
  );

  const run = runnerOf(Context.merge(core, context));
  const logins = Context.get(context, Logins);

  return {
    store,
    agentId,
    state,
    logins,
    run: <A, E>(effect: Effect.Effect<A, E>) => run.runPromise(effect),
    value: async (
      name: string,
      field: "username" | "password" | "one_time_code",
    ) =>
      Redacted.value(await run.runPromise(logins.value(agentId, name, field))),
    usedBy: () =>
      store.run(
        PasswordManagerRepository.use((repository) =>
          repository.usedBy("1password"),
        ),
      ),
  };
}

const failureOf = async (effect: Effect.Effect<unknown, { message: string }>) =>
  Option.getOrUndefined(
    Option.map(
      Exit.findErrorOption(await Effect.runPromiseExit(effect)),
      (error) => error.message,
    ),
  );

const stored = (value: string) => ({ value });

const reference = (path: string) => ({
  reference: { passwordManager: "1password" as const, reference: path },
});

test("a login is saved and listed without its values", async () => {
  const bot = open();

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      fields: { username: stored("ada"), password: stored("hunter2") },
    }),
  );

  const [login] = await bot.run(bot.logins.list(bot.agentId));

  expect(login).toMatchObject({
    name: "github",
    hosts: ["github.com"],
    fields: {
      username: { passwordManager: null, reference: null },
      password: { passwordManager: null, reference: null },
    },
    lastUsedAt: null,
    lastError: null,
  });
  expect(JSON.stringify(login)).not.toContain("hunter2");
  expect(await bot.value("github", "password")).toBe("hunter2");
});

test("a new login needs hosts, a username, and a password", async () => {
  const bot = open();

  expect(
    await failureOf(
      bot.logins.save(bot.agentId, "github", {
        hosts: ["github.com"],
        fields: { username: stored("ada") },
      }),
    ),
  ).toBe("A login needs a username and a password");
  expect(
    await failureOf(
      bot.logins.save(bot.agentId, "github", {
        fields: { username: stored("ada"), password: stored("pw") },
      }),
    ),
  ).toBe("Name at least one host");
  expect(await bot.run(bot.logins.list(bot.agentId))).toEqual([]);
});

test("a 1Password item fills every field, its one-time code only when it has one", async () => {
  const bot = open({
    [`${ITEM}/username`]: "ada",
    [`${ITEM}/password`]: "vault-pw",
  });

  const saved = await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      item: { passwordManager: "1password", reference: ITEM },
    }),
  );

  expect(saved.fields).toEqual({
    username: { passwordManager: "1password", reference: `${ITEM}/username` },
    password: { passwordManager: "1password", reference: `${ITEM}/password` },
  });
  expect(await bot.value("github", "username")).toBe("ada");
  expect(await bot.value("github", "password")).toBe("vault-pw");

  bot.state.values.set(`${ITEM}/one-time password?attribute=totp`, "123456");

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      item: { passwordManager: "1password", reference: ITEM },
    }),
  );

  // 1Password computes the code for this attribute, so it is filled as read.
  expect(await bot.value("github", "one_time_code")).toBe("123456");
});

test("an item's one-time code that can't be checked fails the save instead of dropping the code", async () => {
  const otp = `${ITEM}/one-time password?attribute=totp`;

  const bot = open({
    [`${ITEM}/username`]: "ada",
    [`${ITEM}/password`]: "vault-pw",
    [otp]: "123456",
  });

  const item = { passwordManager: "1password" as const, reference: ITEM };

  await bot.run(
    bot.logins.save(bot.agentId, "github", { hosts: ["github.com"], item }),
  );

  bot.state.unreadable.set(otp, "could not read it: other");

  expect(
    await failureOf(bot.logins.save(bot.agentId, "github", { item })),
  ).toBe("Fake could not read it: other");
  expect(
    (await bot.run(bot.logins.get(bot.agentId, "github")))?.fields
      .one_time_code,
  ).toEqual({ passwordManager: "1password", reference: otp });
});

test("a computed one-time code is read anew for every fill", async () => {
  const otp = `${ITEM}/one-time password?attribute=totp`;

  const bot = open({
    [`${ITEM}/username`]: "ada",
    [`${ITEM}/password`]: "vault-pw",
    [otp]: "123456",
  });

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      item: { passwordManager: "1password", reference: ITEM },
    }),
  );

  bot.state.values.set(otp, "654321");

  expect(await bot.value("github", "one_time_code")).toBe("654321");

  bot.state.mode = "unreachable";

  expect(bot.value("github", "one_time_code")).rejects.toThrow();
});

test("a stored one-time code secret fills the current code", async () => {
  const bot = open();
  const secret = "JBSWY3DPEHPK3PXP";

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      fields: {
        username: stored("ada"),
        password: stored("pw"),
        one_time_code: stored(secret),
      },
    }),
  );

  const before = Date.now();
  const code = await bot.value("github", "one_time_code");

  expect([
    oneTimeCode(parseOneTimeSecret(secret)!, before),
    oneTimeCode(parseOneTimeSecret(secret)!, Date.now()),
  ]).toContain(code);
});

test("a one-time code secret that isn't base32 or a TOTP URI is rejected", async () => {
  const bot = open({ "op://Vault/Bank/otp": "not a secret!" });

  const save = (one_time_code: ReturnType<typeof stored>) =>
    bot.logins.save(bot.agentId, "bank", {
      hosts: ["bank.example.com"],
      fields: {
        username: stored("ada"),
        password: stored("pw"),
        one_time_code,
      },
    });

  expect(await failureOf(save(stored("not a secret!")))).toBe(
    "The one-time code needs its secret in base32, or an otpauth://totp/ URI",
  );
  expect(
    await failureOf(
      bot.logins.save(bot.agentId, "bank", {
        hosts: ["bank.example.com"],
        fields: {
          username: stored("ada"),
          password: stored("pw"),
          one_time_code: reference("op://Vault/Bank/otp"),
        },
      }),
    ),
  ).toBe(
    "The one-time code needs its secret in base32, or an otpauth://totp/ URI",
  );
});

test("replacing a reference with a value drops it from the password manager's users", async () => {
  const bot = open({ "op://Vault/GitHub/password": "vault-pw" });

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      fields: {
        username: stored("ada"),
        password: reference("op://Vault/GitHub/password"),
      },
    }),
  );

  expect(await bot.usedBy()).toEqual([
    { kind: "botLogin", agentId: bot.agentId, name: "github" },
  ]);

  const reads = bot.state.reads;

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      fields: { password: stored("local-pw") },
    }),
  );

  expect(bot.state.reads).toBe(reads);
  expect(await bot.usedBy()).toEqual([]);
  expect(await bot.value("github", "password")).toBe("local-pw");
});

test("a reference that can't be read is rejected and nothing is saved", async () => {
  const bot = open();

  expect(
    await failureOf(
      bot.logins.save(bot.agentId, "github", {
        hosts: ["github.com"],
        fields: {
          username: stored("ada"),
          password: reference("op://Vault/Missing/password"),
        },
      }),
    ),
  ).toBeDefined();
  expect(await bot.run(bot.logins.list(bot.agentId))).toEqual([]);
});

test("uses are listed newest first, and the newest error shows on the login", async () => {
  const bot = open();

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      fields: { username: stored("ada"), password: stored("pw") },
    }),
  );

  const at = new Date().toISOString();

  await bot.run(
    bot.logins.recordUse(bot.agentId, "github", {
      at,
      host: "github.com",
      field: "username",
      error: null,
    }),
  );
  await bot.run(
    bot.logins.recordUse(bot.agentId, "github", {
      at,
      host: "github.com",
      field: "password",
      error: "1Password could not be reached",
    }),
  );

  const uses = await bot.run(
    bot.logins.uses(bot.agentId, "github", { limit: 10 }),
  );

  expect(uses.map((use) => use.field)).toEqual(["password", "username"]);
  expect(
    (await bot.run(bot.logins.get(bot.agentId, "github")))?.lastError,
  ).toBe("1Password could not be reached");
});

test("deleting a login removes it; an unknown one is not found", async () => {
  const bot = open();

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      fields: { username: stored("ada"), password: stored("pw") },
    }),
  );
  await bot.run(bot.logins.delete(bot.agentId, "github"));

  expect(await bot.run(bot.logins.list(bot.agentId))).toEqual([]);
  expect(await failureOf(bot.logins.delete(bot.agentId, "github"))).toBe(
    "Login not found",
  );
});

test("login names and hosts are checked", () => {
  expect(loginSaveInput.safeParse({ hosts: ["127.0.0.1"] }).success).toBe(
    false,
  );
  expect(
    loginSaveInput.safeParse({
      item: {
        passwordManager: "1password",
        reference: "op://Vault/Item/field",
      },
    }).success,
  ).toBe(false);
  expect(
    loginSaveInput.safeParse({
      item: { passwordManager: "1password", reference: ITEM },
      fields: { username: { value: "ada" } },
    }).success,
  ).toBe(false);
});

const githubFields = {
  fields: { username: stored("ada"), password: stored("pw") },
};

const githubRequest = (
  bot: ReturnType<typeof open>,
  hosts = ["github.com"],
  oneTimeCode = true,
) =>
  bot.logins.request(bot.agentId, {
    name: "github",
    hosts,
    reason: "To read private issues",
    one_time_code: oneTimeCode,
  });

const askForGithub = (bot: ReturnType<typeof open>, hosts?: string[]) =>
  bot.run(githubRequest(bot, hosts));

test("saving a requested login answers the request with one notice", async () => {
  const bot = open();
  const { notices, stop } = takeNotices(bot.store);

  expect(await askForGithub(bot)).toMatchObject({
    name: "github",
    hosts: ["github.com"],
    reason: "To read private issues",
    oneTimeCode: true,
  });

  // The request's hosts apply when the save names none.
  await bot.run(bot.logins.save(bot.agentId, "github", githubFields));

  expect(notices.map((notice) => notice.text)).toEqual([
    "The owner saved login github for github.com. Desktop jobs can fill it with fill_login.",
  ]);
  expect(notices[0]!.requestId).toStartWith("login:github:");
  expect(await bot.run(bot.logins.requests(bot.agentId))).toEqual([]);
  stop();
});

test("declining a request notifies the bot, and so does deleting it", async () => {
  const bot = open();
  const { notices, stop } = takeNotices(bot.store);

  await askForGithub(bot);
  await bot.run(bot.logins.decline(bot.agentId, "github"));
  await askForGithub(bot);
  await bot.run(bot.logins.delete(bot.agentId, "github"));

  expect(notices.map((notice) => notice.text)).toEqual([
    "The owner declined your request for login github.",
    "The owner declined your request for login github.",
  ]);
  expect(await failureOf(bot.logins.decline(bot.agentId, "github"))).toBe(
    "Login request has already been answered",
  );
  stop();
});

test("a second request for the same name replaces the first", async () => {
  const bot = open();

  await askForGithub(bot);
  await askForGithub(bot, ["github.com", "api.github.com"]);

  expect(await bot.run(bot.logins.requests(bot.agentId))).toMatchObject([
    { name: "github", hosts: ["github.com", "api.github.com"] },
  ]);
});

test("a request for a login that already covers every host conflicts", async () => {
  const bot = open();

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      ...githubFields,
    }),
  );

  expect(await failureOf(githubRequest(bot, ["github.com"], false))).toBe(
    "Login github is already yours for github.com",
  );
  expect(
    (await askForGithub(bot, ["github.com", "gist.github.com"])).hosts,
  ).toEqual(["github.com", "gist.github.com"]);
});

test("saving a login under another name leaves the request open", async () => {
  const bot = open();
  const { notices, stop } = takeNotices(bot.store);

  await askForGithub(bot);
  await bot.run(
    bot.logins.save(bot.agentId, "github-work", {
      hosts: ["github.com"],
      ...githubFields,
    }),
  );

  expect(notices).toEqual([]);
  expect(
    (await bot.run(bot.logins.requests(bot.agentId))).map(
      (request) => request.name,
    ),
  ).toEqual(["github"]);
  stop();
});

test("a bot can ask for a one-time code its login for the same hosts lacks", async () => {
  const bot = open();

  await bot.run(
    bot.logins.save(bot.agentId, "github", {
      hosts: ["github.com"],
      ...githubFields,
    }),
  );

  expect((await askForGithub(bot)).oneTimeCode).toBe(true);
});
