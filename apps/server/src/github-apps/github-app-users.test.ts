import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Redacted } from "effect";
import { PendingStates, ServerSecrets } from "../secrets/server-secrets";
import { Secrets } from "../secrets/secrets";
import { GitHubUnavailable } from "./github-api";
import { githubOwnerFixture, gate } from "./github-app-users-test-support";
import { githubApps } from "./schema";

const fixtures: ReturnType<typeof githubOwnerFixture>[] = [];

const setup = () => {
  const fixture = githubOwnerFixture();
  fixtures.push(fixture);

  return fixture;
};

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

test("sign-out removes the owner before revocation and fences a successful refresh", async () => {
  const f = setup();
  f.seedOwner();
  const refresh = f.block("refresh");
  const refreshed = f.run(Effect.exit(f.users.token(f.app)));
  await refresh.reached;
  const revoke = f.block("revoke");
  const signedOut = f.run(f.users.signOut(f.app.id));
  await revoke.reached;

  expect(await f.run(f.users.of(f.app.id))).toBeUndefined();
  revoke.release();
  await signedOut;
  refresh.release();
  const result = await refreshed;

  expect(Exit.isFailure(result)).toBe(true);

  if (Exit.isFailure(result))
    expect(Cause.squash(result.cause)).toBeInstanceOf(GitHubUnavailable);
  expect(f.snapshot()).toBeUndefined();
});

for (const sameUser of [true, false]) {
  test(`a refresh cannot overwrite a newer ${sameUser ? "same-user" : "different-user"} sign-in`, async () => {
    const f = setup();
    f.seedOwner();
    const blocked = f.block("refresh");
    const refreshed = f.run(Effect.exit(f.users.token(f.app)));
    await blocked.reached;

    if (!sameUser) f.setOwner({ login: "new-owner", id: 4 });
    await f.signIn();
    const current = f.snapshot();
    blocked.release();

    expect(Exit.isFailure(await refreshed)).toBe(true);
    expect(f.snapshot()).toEqual(current);
    expect(f.box.decrypt(f.snapshot()!.token)).toBe("access-new");
  });
}

for (const boundary of ["exchange", "user"] as const) {
  test(`sign-out fences completion waiting for ${boundary}`, async () => {
    const f = setup();
    const state = await f.started();
    const blocked = f.block(boundary);

    const completion = f.run(
      Effect.exit(f.users.complete({ state, code: "old" })),
    );

    await blocked.reached;
    await f.run(f.users.signOut(f.app.id));
    blocked.release();
    const result = await completion;

    expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
    expect(f.snapshot()).toBeUndefined();
  });
}

test("an old completion cannot overwrite a newer same-user sign-in", async () => {
  const f = setup();
  const state = await f.started();
  const blocked = f.block("exchange");

  const completion = f.run(
    Effect.exit(f.users.complete({ state, code: "old" })),
  );

  await blocked.reached;
  await f.signIn();
  const current = f.snapshot();
  blocked.release();
  const result = await completion;

  expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
  expect(f.snapshot()).toEqual(current);
});

test("sign-out fences completion waiting for a client secret", async () => {
  const f = setup();
  const real = f.store.runtime.runSync(Secrets.use(Effect.succeed));
  const blocked = gate();

  const users = f.withSecrets({
    read: (key) =>
      Effect.andThen(
        Effect.promise(() => blocked.wait()),
        real.read(key),
      ),
  });

  const state = await f.started();
  const completion = f.run(Effect.exit(users.complete({ state, code: "old" })));
  await blocked.reached;
  await f.run(f.users.signOut(f.app.id));
  blocked.release();
  const result = await completion;

  expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
  expect(f.snapshot()).toBeUndefined();
});

test("sign-out fences delayed authorization admission", async () => {
  const f = setup();
  const real = f.store.runtime.runSync(Secrets.use(Effect.succeed));
  const blocked = gate();

  const users = f.withSecrets({
    status: (key) =>
      Effect.andThen(
        Effect.promise(() => blocked.wait()),
        real.status(key),
      ),
  });

  const authorization = f.run(Effect.exit(users.authorize(f.app.id)));
  await blocked.reached;
  await f.run(f.users.signOut(f.app.id));
  blocked.release();
  const result = await authorization;

  expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
  await f.signIn();
  expect((await f.run(f.users.of(f.app.id)))?.login).toBe("owner");
});

test("pending-only sign-out expires old callbacks but permits a new sign-in", async () => {
  const f = setup();
  const state = await f.started();
  await f.run(f.users.signOut(f.app.id));

  const result = await f.run(
    Effect.exit(f.users.complete({ state, code: "old" })),
  );

  expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
  await f.signIn();
  expect(f.box.decrypt(f.snapshot()!.token)).toBe("access-new");
});

test("an older callback cannot adopt a newer sign-in before completion starts", async () => {
  const f = setup();
  const oldState = await f.started();
  await f.signIn();
  const current = f.snapshot();
  const exchanges = f.requests.length;

  const result = await f.run(
    Effect.exit(f.users.complete({ state: oldState, code: "old" })),
  );

  expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
  expect(f.snapshot()).toEqual(current);
  expect(f.requests).toHaveLength(exchanges);
});

test("late sign-out revocation cannot delete a new local sign-in", async () => {
  const f = setup();
  f.seedOwner();
  const revoke = f.block("revoke");
  const signedOut = f.run(f.users.signOut(f.app.id));
  await revoke.reached;
  expect(f.snapshot()).toBeUndefined();
  await f.signIn();
  const current = f.snapshot();
  f.failRevocation();
  revoke.release();
  await signedOut;

  expect(f.snapshot()).toEqual(current);
  const revocation = f.requests.find((request) => request.method === "DELETE");

  expect(await revocation?.json()).toEqual({ access_token: "original-access" });
});

test("legacy owner credentials gain identity without changing tokens or deadlines", async () => {
  const f = setup();
  f.seedOwner(4_000_000_000_000);
  const before = f.snapshot();
  const token = await f.run(f.users.token(f.app));

  const metadata = await f.run(
    ServerSecrets.use((secrets) =>
      secrets.get(`github-app-user-auth:${f.app.id}`),
    ),
  );

  expect(Redacted.value(token)).toBe("original-access");
  expect(f.snapshot()).toEqual(before);
  expect(metadata && JSON.parse(metadata)).toMatchObject({
    epoch: expect.any(String),
    owner: expect.any(String),
  });
});

test("legacy pending callbacks are stale", async () => {
  const f = setup();
  await f.run(
    PendingStates.use((states) =>
      states.put("github-app-user-state", "legacy", {
        appId: f.app.id,
        verifier: "legacy-verifier",
      }),
    ),
  );

  const result = await f.run(
    Effect.exit(f.users.complete({ state: "legacy", code: "old" })),
  );

  expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
  expect(f.snapshot()).toBeUndefined();
});

test("removing an App prevents delayed completion from recreating authorization", async () => {
  const f = setup();
  const state = await f.started();
  const blocked = f.block("exchange");

  const completion = f.run(
    Effect.exit(f.users.complete({ state, code: "old" })),
  );

  await blocked.reached;
  await f.run(
    f.db
      .delete(githubApps)
      .where(eq(githubApps.id, f.app.id))
      .pipe(Effect.orDie),
  );
  blocked.release();
  const result = await completion;

  expect(Exit.isFailure(result) && String(result.cause)).toContain("stale");
  expect(f.snapshot()).toBeUndefined();
});

test("normal refresh rotates once while concurrent requests wait", async () => {
  const f = setup();
  f.seedOwner();
  const blocked = f.block("refresh");
  const first = f.run(f.users.token(f.app));
  await blocked.reached;
  const second = f.run(f.users.token(f.app));
  blocked.release();
  const tokens = await Promise.all([first, second]);

  expect(tokens.map(Redacted.value)).toEqual([
    "access-refresh-1",
    "access-refresh-1",
  ]);
  expect(f.refreshTokens).toEqual(["original-refresh"]);
  expect(f.box.decrypt(f.snapshot()!.refreshToken)).toBe("renewal-refresh-1");
});

test("malformed authorization identity fails closed", async () => {
  const f = setup();
  f.seedOwner();
  await f.run(
    ServerSecrets.use((secrets) =>
      secrets.set(`github-app-user-auth:${f.app.id}`, "{}"),
    ),
  );
  const before = f.snapshot();
  const result = await f.run(Effect.exit(f.users.token(f.app)));

  expect(Exit.isFailure(result)).toBe(true);
  expect(f.snapshot()).toEqual(before);
  expect(f.refreshTokens).toEqual([]);
});

for (const operation of ["sign-out", "refresh", "completion"] as const) {
  test(`a failed ${operation} write cannot acknowledge success or commit partial state`, async () => {
    const f = setup();
    f.seedOwner();
    await f.run(f.users.authorize(f.app.id));

    const metadataBefore = await f.run(
      ServerSecrets.use((secrets) =>
        secrets.get(`github-app-user-auth:${f.app.id}`),
      ),
    );

    const before = f.snapshot();
    const state = await f.started();

    const statements = {
      "sign-out":
        "CREATE TRIGGER reject_owner_write BEFORE DELETE ON github_app_users BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
      refresh:
        "CREATE TRIGGER reject_owner_write BEFORE UPDATE ON github_app_users BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
      completion:
        "CREATE TRIGGER reject_owner_write BEFORE UPDATE ON credentials WHEN NEW.key = 'github-app-user-auth:fixture-app' BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END",
    };

    f.fault(statements[operation]);

    const action = {
      "sign-out": f.users.signOut(f.app.id),
      refresh: f.users.token(f.app),
      completion: f.users.complete({ state, code: "new" }),
    }[operation];

    const result = await f.run(Effect.exit(action));

    expect(Exit.isFailure(result)).toBe(true);
    expect(f.snapshot()).toEqual(before);
    expect(
      await f.run(
        ServerSecrets.use((secrets) =>
          secrets.get(`github-app-user-auth:${f.app.id}`),
        ),
      ),
    ).toBe(metadataBefore);
    expect(
      f.requests.filter((request) => request.method === "DELETE"),
    ).toHaveLength(0);
  });
}
