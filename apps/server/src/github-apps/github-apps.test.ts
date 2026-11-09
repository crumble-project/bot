import { afterEach, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { GitHubApps } from "./github-apps";
import { githubOwnerFixture } from "./github-app-users-test-support";

let fixture: ReturnType<typeof githubOwnerFixture> | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

test("a stale owner refresh leaves subsequent credential requests on installation tokens", async () => {
  const f = githubOwnerFixture();
  fixture = f;
  const bot = f.assignBot();
  f.seedOwner();
  const blocked = f.block("refresh");
  const refresh = f.run(Effect.exit(f.users.token(f.app)));
  await blocked.reached;
  await f.run(f.users.signOut(f.app.id));
  blocked.release();
  await refresh;

  const token = await f.run(
    GitHubApps.use((apps) =>
      apps.token(bot.id, {
        host: "api.github.com",
        path: "/repos/fixture-owner/project",
      }),
    ),
  );

  expect(Redacted.value(token)).toBe("installation-fixture");
  expect(
    f.requests.filter(
      (request) =>
        new URL(request.url).pathname === "/app/installations/42/access_tokens",
    ),
  ).toHaveLength(1);
  expect(f.snapshot()).toBeUndefined();
});
