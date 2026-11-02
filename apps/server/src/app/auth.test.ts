import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { createAuth, passkeyOriginFor } from "./auth";
import { INVITE_HEADER } from "./invites";

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
