import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { Unavailable } from "../shared/errors";
import { GitHubUnavailable } from "./github-api";
import { GitHubAccounts } from "./github-accounts";
import { GitHubAppUsers } from "./github-app-users";
import { GitHubApps } from "./github-apps";

const github = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.mapError((error) =>
      error instanceof GitHubUnavailable
        ? new Unavailable({ message: error.message })
        : error,
    ),
  );

type GitHubRoutes = {
  register: Register<Env, GitHubApps | GitHubAppUsers | GitHubAccounts>;
  botIdsOf: (botIds: readonly string[]) => string[];
};

function registerAppRoutes(routeSet: GitHubRoutes) {
  const { register, botIdsOf } = routeSet;

  register(routes.githubApps, function* (c) {
    const githubApps = yield* GitHubApps;

    return c.json({ apps: yield* github(githubApps.list) }, 200);
  });
  register(routes.createGithubAppManifest, function* (c) {
    const input = c.req.valid("json");
    const githubApps = yield* GitHubApps;

    return c.json(
      yield* github(
        githubApps.manifest({
          ...input,
          origin: new URL(input.origin).origin,
        }),
      ),
      200,
    );
  });
  register(routes.completeGithubApp, function* (c) {
    const githubApps = yield* GitHubApps;

    return c.json(yield* github(githubApps.complete(c.req.valid("json"))), 200);
  });
  register(routes.connectGithubApp, function* (c) {
    const githubApps = yield* GitHubApps;

    return c.json(yield* github(githubApps.connect(c.req.param("id"))), 200);
  });
  register(routes.setGithubAppBots, function* (c) {
    const githubApps = yield* GitHubApps;

    return c.json(
      yield* github(
        githubApps.assign(
          c.req.param("id"),
          botIdsOf(c.req.valid("json").botIds),
        ),
      ),
      200,
    );
  });
  register(routes.deleteGithubApp, function* (c) {
    const githubApps = yield* GitHubApps;

    yield* github(githubApps.remove(c.req.param("id")));

    return c.body(null, 204);
  });
}

function registerAppSignInRoutes(routeSet: GitHubRoutes) {
  const { register } = routeSet;

  register(routes.signInGithubApp, function* (c) {
    const githubAppUsers = yield* GitHubAppUsers;

    return c.json(
      { url: yield* github(githubAppUsers.authorize(c.req.param("id"))) },
      200,
    );
  });
  register(routes.completeGithubAppSignIn, function* (c) {
    const input = c.req.valid("json");
    const githubAppUsers = yield* GitHubAppUsers;
    const githubApps = yield* GitHubApps;

    return c.json(
      yield* github(
        githubAppUsers.complete(input).pipe(Effect.flatMap(githubApps.get)),
      ),
      200,
    );
  });
  register(routes.signOutGithubApp, function* (c) {
    const id = c.req.param("id");
    const githubAppUsers = yield* GitHubAppUsers;
    const githubApps = yield* GitHubApps;

    return c.json(
      yield* github(
        githubApps
          .get(id)
          .pipe(
            Effect.andThen(githubAppUsers.signOut(id)),
            Effect.andThen(githubApps.get(id)),
          ),
      ),
      200,
    );
  });
  register(routes.setGithubAppClientSecret, function* (c) {
    const id = c.req.param("id");
    const clientSecret = c.req.valid("json");
    const githubAppUsers = yield* GitHubAppUsers;
    const githubApps = yield* GitHubApps;

    return c.json(
      yield* github(
        githubAppUsers
          .setClientSecret(id, clientSecret)
          .pipe(Effect.andThen(githubApps.get(id))),
      ),
      200,
    );
  });
}

function registerAccountRoutes(routeSet: GitHubRoutes) {
  const { register, botIdsOf } = routeSet;

  register(routes.githubAccounts, function* (c) {
    const githubAccounts = yield* GitHubAccounts;

    return c.json({ accounts: yield* github(githubAccounts.list) }, 200);
  });
  register(routes.addGithubAccount, function* (c) {
    const token = c.req.valid("json");
    const githubAccounts = yield* GitHubAccounts;

    return c.json(yield* github(githubAccounts.add(token)), 200);
  });
  register(routes.setGithubAccountToken, function* (c) {
    const token = c.req.valid("json");
    const githubAccounts = yield* GitHubAccounts;

    return c.json(
      yield* github(githubAccounts.setToken(c.req.param("id"), token)),
      200,
    );
  });
  register(routes.setGithubAccountBots, function* (c) {
    const botIds = botIdsOf(c.req.valid("json").botIds);
    const githubApps = yield* GitHubApps;

    return c.json(
      yield* github(githubApps.assignAccount(c.req.param("id"), botIds)),
      200,
    );
  });
  register(routes.deleteGithubAccount, function* (c) {
    const githubApps = yield* GitHubApps;

    yield* github(githubApps.removeAccount(c.req.param("id")));

    return c.body(null, 204);
  });
}

export function registerGitHubAppRoutes(options: {
  register: Register<Env, GitHubApps | GitHubAppUsers | GitHubAccounts>;
  service: BotLookup;
}) {
  const { register, service } = options;

  const botIdsOf = (botIds: readonly string[]) => {
    for (const botId of botIds) service.agent(botId);

    return [...new Set(botIds)];
  };

  const routeSet: GitHubRoutes = {
    register,
    botIdsOf,
  };

  registerAppRoutes(routeSet);
  registerAppSignInRoutes(routeSet);
  registerAccountRoutes(routeSet);
}
