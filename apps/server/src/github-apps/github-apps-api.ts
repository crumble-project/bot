import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import type { Runner } from "../shared/runner";
import { Unavailable } from "../shared/errors";
import { GitHubUnavailable } from "./github-api";
import { GitHubAccounts } from "./github-accounts";
import { GitHubAppUsers } from "./github-app-users";
import { GitHubApps } from "./github-apps";

type GitHubRoutesRunner = Runner<GitHubApps | GitHubAppUsers | GitHubAccounts>;

const githubRunner =
  (run: GitHubRoutesRunner) =>
  <A, E>(effect: Effect.Effect<A, E>) =>
    run.runPromise(
      effect.pipe(
        Effect.mapError((error) =>
          error instanceof GitHubUnavailable
            ? new Unavailable({ message: error.message })
            : error,
        ),
      ),
    );

type GitHubRoutes = {
  register: Register;
  github: ReturnType<typeof githubRunner>;
  botIdsOf: (botIds: readonly string[]) => string[];
  githubApps: GitHubApps["Service"];
  githubAppUsers: GitHubAppUsers["Service"];
  githubAccounts: GitHubAccounts["Service"];
};

function registerAppRoutes(routeSet: GitHubRoutes) {
  const { register, github, botIdsOf, githubApps } = routeSet;

  register(routes.githubApps, async (c) =>
    c.json({ apps: await github(githubApps.list) }, 200),
  );
  register(routes.createGithubAppManifest, async (c) => {
    const input = c.req.valid("json");

    return c.json(
      await github(
        githubApps.manifest({
          ...input,
          origin: new URL(input.origin).origin,
        }),
      ),
      200,
    );
  });
  register(routes.completeGithubApp, async (c) =>
    c.json(await github(githubApps.complete(c.req.valid("json"))), 200),
  );
  register(routes.connectGithubApp, async (c) =>
    c.json(await github(githubApps.connect(c.req.param("id"))), 200),
  );
  register(routes.setGithubAppBots, async (c) =>
    c.json(
      await github(
        githubApps.assign(
          c.req.param("id"),
          botIdsOf(c.req.valid("json").botIds),
        ),
      ),
      200,
    ),
  );
  register(routes.deleteGithubApp, async (c) => {
    await github(githubApps.remove(c.req.param("id")));

    return c.body(null, 204);
  });
}

function registerAppSignInRoutes(routeSet: GitHubRoutes) {
  const { register, github, githubApps, githubAppUsers } = routeSet;

  register(routes.signInGithubApp, async (c) =>
    c.json(
      { url: await github(githubAppUsers.authorize(c.req.param("id"))) },
      200,
    ),
  );
  register(routes.completeGithubAppSignIn, async (c) => {
    const input = c.req.valid("json");

    return c.json(
      await github(
        githubAppUsers.complete(input).pipe(Effect.flatMap(githubApps.get)),
      ),
      200,
    );
  });
  register(routes.signOutGithubApp, async (c) => {
    const id = c.req.param("id");

    return c.json(
      await github(
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
  register(routes.setGithubAppClientSecret, async (c) => {
    const id = c.req.param("id");

    const clientSecret = c.req.valid("json");

    return c.json(
      await github(
        githubAppUsers
          .setClientSecret(id, clientSecret)
          .pipe(Effect.andThen(githubApps.get(id))),
      ),
      200,
    );
  });
}

function registerAccountRoutes(routeSet: GitHubRoutes) {
  const { register, github, botIdsOf, githubApps, githubAccounts } = routeSet;

  register(routes.githubAccounts, async (c) =>
    c.json({ accounts: await github(githubAccounts.list) }, 200),
  );
  register(routes.addGithubAccount, async (c) => {
    const token = c.req.valid("json");

    return c.json(await github(githubAccounts.add(token)), 200);
  });
  register(routes.setGithubAccountToken, async (c) => {
    const token = c.req.valid("json");

    return c.json(
      await github(githubAccounts.setToken(c.req.param("id"), token)),
      200,
    );
  });
  register(routes.setGithubAccountBots, async (c) => {
    const botIds = botIdsOf(c.req.valid("json").botIds);

    return c.json(
      await github(githubApps.assignAccount(c.req.param("id"), botIds)),
      200,
    );
  });
  register(routes.deleteGithubAccount, async (c) => {
    await github(githubApps.removeAccount(c.req.param("id")));

    return c.body(null, 204);
  });
}

export function registerGitHubAppRoutes(options: {
  register: Register;
  service: BotLookup;
  run: GitHubRoutesRunner;
}) {
  const { register, service, run } = options;

  const botIdsOf = (botIds: readonly string[]) => {
    for (const botId of botIds) service.agent(botId);

    return [...new Set(botIds)];
  };

  const routeSet: GitHubRoutes = {
    register,
    github: githubRunner(run),
    botIdsOf,
    githubApps: run.runSync(GitHubApps.use(Effect.succeed)),
    githubAppUsers: run.runSync(GitHubAppUsers.use(Effect.succeed)),
    githubAccounts: run.runSync(GitHubAccounts.use(Effect.succeed)),
  };

  registerAppRoutes(routeSet);
  registerAppSignInRoutes(routeSet);
  registerAccountRoutes(routeSet);
}
