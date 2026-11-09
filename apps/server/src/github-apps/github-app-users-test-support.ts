import { expect, spyOn } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import { Store } from "../../test/support/store";
import { agentInput } from "../contract/agents";
import { gate } from "../integrations/mcp-oauth-test-support";
import { Secrets } from "../secrets/secrets";
import { ProductDatabase } from "../shared/product-database";
import { SecretBox } from "../shared/secret-box";
import { GitHubAppUsers, githubAppClientSecretKey } from "./github-app-users";
import { githubAppBots, githubApps, githubAppUsers } from "./schema";

export { gate };

type Gate = ReturnType<typeof gate>;

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export function githubOwnerFixture() {
  const folder = mkdtempSync(join(tmpdir(), "github-owner-"));
  const store = new Store(folder);
  const db = store.runtime.runSync(ProductDatabase.use(Effect.succeed));
  const box = store.runtime.runSync(SecretBox.use(Effect.succeed));
  const users = store.runtime.runSync(GitHubAppUsers.use(Effect.succeed));
  const scopes: Scope.Closeable[] = [];
  const gates: Gate[] = [];
  const unexpected: string[] = [];
  const requests: Request[] = [];
  const refreshTokens: string[] = [];
  let owner = { login: "owner", id: 3 };
  let exchangeGate: Gate | undefined;
  let refreshGate: Gate | undefined;
  let userGate: Gate | undefined;
  let revokeGate: Gate | undefined;
  let revokeFails = false;

  const app = {
    id: "fixture-app",
    appId: 1,
    slug: "fixture-app",
    name: "Fixture App",
    clientId: "fixture-client",
    privateKey: box.encrypt(privateKey),
    botUserId: 11,
    htmlUrl: "https://github.com/apps/fixture-app",
    account: "fixture-owner",
    installationId: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  store.runtime.runSync(db.insert(githubApps).values(app).pipe(Effect.orDie));
  store.setCredential(
    githubAppClientSecretKey(app.id),
    "fixture-client-secret",
  );

  const answerToken = async (request: Request) => {
    const params = new URLSearchParams(await request.text());
    const refresh = params.get("grant_type") === "refresh_token";

    const suffix = refresh
      ? `refresh-${refreshTokens.length + 1}`
      : params.get("code");

    if (refresh) refreshTokens.push(params.get("refresh_token") ?? "");

    const blocked = refresh ? refreshGate : exchangeGate;

    if (refresh) refreshGate = undefined;
    else exchangeGate = undefined;
    await blocked?.wait();

    return Response.json({
      access_token: `access-${suffix}`,
      expires_in: 3600,
      refresh_token: `renewal-${suffix}`,
      refresh_token_expires_in: 36000,
    });
  };

  const intercept = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const request = new Request(input, init);
    requests.push(request);
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      request.url === "https://github.com/login/oauth/access_token"
    )
      return answerToken(request);

    if (
      request.method === "GET" &&
      request.url === "https://api.github.com/user"
    ) {
      const answer = { ...owner };
      const blocked = userGate;
      userGate = undefined;
      await blocked?.wait();

      return Response.json(answer);
    }

    if (
      request.method === "DELETE" &&
      url.origin === "https://api.github.com" &&
      url.pathname === "/applications/fixture-client/grant"
    ) {
      await revokeGate?.wait();

      return new Response(null, { status: revokeFails ? 500 : 204 });
    }

    if (
      request.method === "POST" &&
      request.url ===
        "https://api.github.com/app/installations/42/access_tokens"
    ) {
      return Response.json({
        token: "installation-fixture",
        expires_at: "2099-01-01T00:00:00.000Z",
      });
    }

    unexpected.push(`${request.method} ${request.url}`);
    throw new Error("Unexpected GitHub fixture request");
  };

  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(intercept, {
      preconnect: () => {
        unexpected.push("preconnect");
        throw new Error("Unexpected GitHub fixture preconnect");
      },
    }),
  );

  const tasks = new Set<Promise<unknown>>();

  const run: typeof store.runtime.runPromise = (effect, options) => {
    const pending = store.runtime.runPromise(effect, options);
    tasks.add(pending);
    void pending.then(
      () => tasks.delete(pending),
      () => tasks.delete(pending),
    );

    return pending;
  };

  const snapshot = () =>
    store.runtime.runSync(
      db
        .select()
        .from(githubAppUsers)
        .where(eq(githubAppUsers.appId, app.id))
        .pipe(
          Effect.map((rows) => rows[0]),
          Effect.orDie,
        ),
    );

  const started = async (service = users) => {
    const url = await run(service.authorize(app.id));
    const state = new URL(url).searchParams.get("state");

    if (!state) throw new Error("missing sign-in state");

    return state;
  };

  return {
    app,
    store,
    db,
    box,
    users,
    run,
    snapshot,
    requests,
    refreshTokens,
    started,
    signIn: async (code = "new", service = users) =>
      run(service.complete({ code, state: await started(service) })),
    seedOwner: (expiresAt = 0) =>
      store.runtime.runSync(
        db
          .insert(githubAppUsers)
          .values({
            appId: app.id,
            login: "owner",
            userId: 3,
            token: box.encrypt("original-access"),
            expiresAt,
            refreshToken: box.encrypt("original-refresh"),
            refreshExpiresAt: 4_000_000_000_000,
          })
          .pipe(Effect.orDie),
      ),
    setOwner: (next: typeof owner) => {
      owner = next;
    },
    block: (kind: "exchange" | "refresh" | "user" | "revoke") => {
      const blocked = gate();
      gates.push(blocked);

      if (kind === "exchange") exchangeGate = blocked;

      if (kind === "refresh") refreshGate = blocked;

      if (kind === "user") userGate = blocked;

      if (kind === "revoke") revokeGate = blocked;

      return blocked;
    },
    failRevocation: () => {
      revokeFails = true;
    },
    withSecrets: (overrides: Partial<Secrets["Service"]>) => {
      const context = store.runtime.runSync(Effect.context());
      const real = Context.get(context, Secrets);
      const scope = Scope.makeUnsafe();
      scopes.push(scope);

      const built = Effect.runSync(
        Layer.buildWithScope(
          GitHubAppUsers.layer.pipe(
            Layer.provide(
              Layer.succeedContext(
                Context.add(
                  context,
                  Secrets,
                  Secrets.of({ ...real, ...overrides }),
                ),
              ),
            ),
          ),
          scope,
        ),
      );

      return Context.get(built, GitHubAppUsers);
    },
    fault: (statement: string) => {
      const connection = new Database(join(folder, "store.sqlite"));
      connection.run(statement);
      connection.close();
    },
    assignBot: () => {
      const bot = store.createAgent(agentInput.parse({ name: "Fixture bot" }));
      store.runtime.runSync(
        db
          .insert(githubAppBots)
          .values({ appId: app.id, agentId: bot.id, assignedAt: app.createdAt })
          .pipe(Effect.orDie),
      );

      return bot;
    },
    close: async () => {
      for (const blocked of gates) blocked.release();
      await Promise.allSettled(tasks);
      fetchSpy.mockRestore();

      for (const scope of scopes) Effect.runSync(Scope.close(scope, Exit.void));
      store.close();
      rmSync(folder, { recursive: true, force: true });
      expect(unexpected).toEqual([]);
    },
  };
}
