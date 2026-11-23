import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { expect, setDefaultTimeout, test } from "bun:test";
import { z } from "zod";
import { createAuth, passkeyOriginFor } from "./auth";
import { DEFAULT_SERVER_SETTINGS } from "./server-settings";
import { INVITE_HEADER } from "./invites";

setDefaultTimeout(30_000);

test("binds passkeys to localhost for a loopback origin", () => {
  expect(passkeyOriginFor("http://127.0.0.1:7337")).toBe(
    "http://localhost:7337",
  );
  expect(passkeyOriginFor("http://[::1]:7337")).toBe("http://localhost:7337");
});

test("binds passkeys to a hostname origin as given", () => {
  expect(passkeyOriginFor("https://crumble.tailnet.ts.net")).toBe(
    "https://crumble.tailnet.ts.net",
  );
  expect(passkeyOriginFor("http://localhost:7337")).toBe(
    "http://localhost:7337",
  );
});

const signUp = (
  accounts: Awaited<ReturnType<typeof createAuth>>,
  email: string,
  invite?: string,
) =>
  accounts.auth.api.signUpEmail({
    body: { email, password: "correct horse battery", name: email },
    headers: new Headers(invite ? { [INVITE_HEADER]: invite } : {}),
  });

const roleOf = async (
  accounts: Awaited<ReturnType<typeof createAuth>>,
  userId: string,
) => ((await accounts.isAdmin(userId)) ? "admin" : "user");

test("one stored setting that no longer validates keeps sign-up closed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "auth-"));
  const first = await createAuth(dataDir, "http://localhost:7337");

  await first.settings.update({ signUpOpen: false, workspaceCpus: 8 });
  first.close();

  const database = new Database(join(dataDir, "auth.sqlite"));

  database.run(
    "UPDATE serverSetting SET value = '1000' WHERE key = 'workspaceCpus'",
  );
  database.close();

  const reopened = await createAuth(dataDir, "http://localhost:7337");

  try {
    expect(reopened.settings.get()).toEqual({
      ...DEFAULT_SERVER_SETTINGS,
      signUpOpen: false,
    });
  } finally {
    reopened.close();
  }
});

test("a stored sign-up setting that no longer validates reads as closed", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "auth-"));
  const first = await createAuth(dataDir, "http://localhost:7337");

  await first.settings.update({ signUpOpen: false });
  first.close();

  const database = new Database(join(dataDir, "auth.sqlite"));

  database.run(
    "UPDATE serverSetting SET value = 'not json' WHERE key = 'signUpOpen'",
  );
  database.close();

  const reopened = await createAuth(dataDir, "http://localhost:7337");

  try {
    expect(reopened.settings.get().signUpOpen).toBe(false);
  } finally {
    reopened.close();
  }
});

test("makes the first account admin and later ones users", async () => {
  const accounts = await createAuth(
    mkdtempSync(join(tmpdir(), "auth-")),
    "http://localhost:7337",
  );

  try {
    const first = await signUp(accounts, "first@example.com");
    const second = await signUp(accounts, "second@example.com");

    expect(await roleOf(accounts, first.user.id)).toBe("admin");
    expect(await roleOf(accounts, second.user.id)).toBe("user");
  } finally {
    accounts.close();
  }
});

test("promotes the oldest user of a server without an admin", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "auth-"));
  let accounts = await createAuth(dataDir, "http://localhost:7337");
  const first = await signUp(accounts, "first@example.com");
  const second = await signUp(accounts, "second@example.com");

  await accounts.adapter.update({
    model: "user",
    where: [{ field: "id", value: first.user.id }],
    update: { role: "user" },
  });
  accounts.close();
  accounts = await createAuth(dataDir, "http://localhost:7337");

  try {
    expect(await roleOf(accounts, first.user.id)).toBe("admin");
    expect(await roleOf(accounts, second.user.id)).toBe("user");
  } finally {
    accounts.close();
  }
});

test("closed sign-up needs an open invite, which works once", async () => {
  const accounts = await createAuth(
    mkdtempSync(join(tmpdir(), "auth-")),
    "http://localhost:7337",
  );

  try {
    const admin = await signUp(accounts, "admin@example.com");

    await accounts.settings.update({ signUpOpen: false });
    expect(signUp(accounts, "nobody@example.com")).rejects.toThrow(
      "Sign-up is closed",
    );

    const { token } = await accounts.invites.create(admin.user.id);
    const invited = await signUp(accounts, "invited@example.com", token);

    expect(await roleOf(accounts, invited.user.id)).toBe("user");
    expect(signUp(accounts, "again@example.com", token)).rejects.toThrow(
      "Sign-up is closed",
    );

    const revoked = await accounts.invites.create(admin.user.id);

    await accounts.invites.revoke(revoked.id);
    expect(
      signUp(accounts, "revoked@example.com", revoked.token),
    ).rejects.toThrow("Sign-up is closed");
    expect(await accounts.invites.pending()).toEqual([]);
  } finally {
    accounts.close();
  }
});

const ORIGIN = "http://localhost:7337";

const authRequest = (
  accounts: Awaited<ReturnType<typeof createAuth>>,
  token: string,
  path: string,
  body?: unknown,
) =>
  accounts.auth.handler(
    new Request(`${ORIGIN}/api/auth/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        origin: ORIGIN,
      },
      body: body === undefined ? null : JSON.stringify(body),
    }),
  );

const pinsOf = async (
  accounts: Awaited<ReturnType<typeof createAuth>>,
  token: string,
) => {
  const session = (await (
    await authRequest(accounts, token, "get-session")
  ).json()) as { user: { pinnedConversations?: unknown } };

  return session.user.pinnedConversations;
};

test("the avatar material is flat until the account chooses fluffy", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "auth-material-"));
  let accounts = await createAuth(dataDir, ORIGIN);

  const materialOf = async (token: string) => {
    const response = await authRequest(accounts, token, "get-session");

    const session = z
      .object({ user: z.object({ avatarMaterial: z.unknown() }) })
      .parse(await response.json());

    return session.user.avatarMaterial;
  };

  try {
    const { token } = await signUp(accounts, "material@example.com");
    expect(await materialOf(token!)).toBe("flat");

    const saved = await authRequest(accounts, token!, "update-user", {
      avatarMaterial: "fluffy",
    });

    expect(saved.status).toBe(200);
    expect(await materialOf(token!)).toBe("fluffy");

    const rejected = await authRequest(accounts, token!, "update-user", {
      avatarMaterial: "plush",
    });

    expect(rejected.status).toBe(400);
    expect(await materialOf(token!)).toBe("fluffy");

    accounts.close();
    const database = new Database(join(dataDir, "auth.sqlite"));
    database.run("ALTER TABLE user DROP COLUMN avatarMaterial");
    database.close();
    accounts = await createAuth(dataDir, ORIGIN);

    expect(await materialOf(token!)).toBe("flat");
  } finally {
    accounts.close();
  }
});

test("a new account has no pins", async () => {
  const accounts = await createAuth(
    mkdtempSync(join(tmpdir(), "auth-")),
    ORIGIN,
  );

  try {
    const { token } = await signUp(accounts, "pins@example.com");

    expect(await pinsOf(accounts, token!)).toEqual([]);
  } finally {
    accounts.close();
  }
});

test("restart removes only group pins and preserves bot order and sessions", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "auth-group-pins-"));
  let accounts = await createAuth(dataDir, ORIGIN);
  const { token } = await signUp(accounts, "upgrade-pins@example.com");
  accounts.close();
  const database = new Database(join(dataDir, "auth.sqlite"));
  database
    .query("UPDATE user SET pinnedConversations = ?")
    .run(JSON.stringify(["agent:second", "group:old", "agent:first"]));
  database.close();

  for (let attempt = 0; attempt < 2; attempt++) {
    accounts = await createAuth(dataDir, ORIGIN);
    try {
      expect(await pinsOf(accounts, token!)).toEqual([
        "agent:second",
        "agent:first",
      ]);
    } finally {
      accounts.close();
    }
  }
});

test("saves pins in order", async () => {
  const accounts = await createAuth(
    mkdtempSync(join(tmpdir(), "auth-")),
    ORIGIN,
  );

  try {
    const { token } = await signUp(accounts, "pins@example.com");
    const saved = await authRequest(accounts, token!, "update-user", {
      pinnedConversations: ["agent:b2", "agent:b1"],
    });

    expect(saved.status).toBe(200);
    expect(await pinsOf(accounts, token!)).toEqual(["agent:b2", "agent:b1"]);
  } finally {
    accounts.close();
  }
});

test("rejects more than nine pins, duplicates, and malformed keys", async () => {
  const accounts = await createAuth(
    mkdtempSync(join(tmpdir(), "auth-")),
    ORIGIN,
  );

  try {
    const { token } = await signUp(accounts, "pins@example.com");
    await authRequest(accounts, token!, "update-user", {
      pinnedConversations: ["agent:kept"],
    });
    const tooMany = Array.from({ length: 10 }, (_, index) => `agent:${index}`);

    for (const pinnedConversations of [
      tooMany,
      ["agent:a", "agent:a"],
      ["bot:a"],
      ["group:obsolete"],
    ]) {
      const response = await authRequest(accounts, token!, "update-user", {
        pinnedConversations,
      });

      expect(response.status).toBe(400);
    }
    expect(await pinsOf(accounts, token!)).toEqual(["agent:kept"]);
  } finally {
    accounts.close();
  }
});

test("updating pins tells the account's listener", async () => {
  const calls: [string, string[]][] = [];
  const accounts = await createAuth(
    mkdtempSync(join(tmpdir(), "auth-")),
    ORIGIN,
    { onPinsChanged: (userId, pins) => calls.push([userId, pins]) },
  );

  try {
    const { token, user } = await signUp(accounts, "pins@example.com");
    await authRequest(accounts, token!, "update-user", {
      pinnedConversations: ["agent:b1"],
    });

    expect(calls).toEqual([[user.id, ["agent:b1"]]]);
  } finally {
    accounts.close();
  }
});

test("an account from before pins reads as no pins", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "auth-"));
  const accounts = await createAuth(dataDir, ORIGIN);

  try {
    const { token } = await signUp(accounts, "older@example.com");

    const database = new Database(join(dataDir, "auth.sqlite"));
    database.run('update user set "pinnedConversations" = NULL');
    database.close();

    expect(await pinsOf(accounts, token!)).toEqual([]);
  } finally {
    accounts.close();
  }
});
