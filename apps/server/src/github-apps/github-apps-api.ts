import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import {
  githubAppClientSecretInput,
  githubAppCompleteInput,
  githubAppSignInInput,
  githubAppManifestInput,
  githubAccountTokenInput,
  githubBotsInput,
} from "../contract/github-apps";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import type { Runner } from "../shared/runner";
import { Unavailable } from "../shared/errors";
import { GitHubUnavailable } from "./github-api";
import { GitHubAccounts } from "./github-accounts";
import { GitHubAppUsers } from "./github-app-users";
import { GitHubApps } from "./github-apps";

/** The account's GitHub Apps and machine accounts: adding, installing, signing the owner in, assigning to bots, and
 * removing them. */
export function registerGitHubAppRoutes(options: {
  register: Register;
  service: BotsAccess;
  run: Runner<GitHubApps | GitHubAppUsers | GitHubAccounts>;
}) {
  const { register, service, run } = options;
  const githubApps = run.runSync(GitHubApps.use(Effect.succeed));
  const githubAppUsers = run.runSync(GitHubAppUsers.use(Effect.succeed));
  const githubAccounts = run.runSync(GitHubAccounts.use(Effect.succeed));

  // GitHub being unreachable is the server's problem to report, not a defect.
  const github = <A, E>(effect: Effect.Effect<A, E>) =>
    Effect.runPromise(
      effect.pipe(
        Effect.mapError((error) =>
          error instanceof GitHubUnavailable
            ? new Unavailable({ message: error.message })
            : error,
        ),
      ),
    );

  const botIdsOf = (botIds: readonly string[]) => {
    for (const botId of botIds) service.agent(botId);

    return [...new Set(botIds)];
  };

  register(routes.githubApps, async (c) =>
    c.json({ apps: await github(githubApps.list) }, 200),
  );
  register(routes.createGithubAppManifest, async (c) => {
    const input = githubAppManifestInput.parse(await c.req.json());

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
  register(routes.completeGithubApp, async (c) => {
    const input = githubAppCompleteInput.parse(await c.req.json());

    return c.json(await github(githubApps.complete(input)), 200);
  });
  register(routes.connectGithubApp, async (c) =>
    c.json(await github(githubApps.connect(c.req.param("id"))), 200),
  );
  register(routes.setGithubAppBots, async (c) =>
    c.json(
      await github(
        githubApps.assign(
          c.req.param("id"),
          botIdsOf(githubBotsInput.parse(await c.req.json()).botIds),
        ),
      ),
      200,
    ),
  );
  register(routes.deleteGithubApp, async (c) => {
    await github(githubApps.remove(c.req.param("id")));

    return c.body(null, 204);
  });

  register(routes.signInGithubApp, async (c) => {
    const { origin } = githubAppSignInInput.parse(await c.req.json());

    return c.json(
      {
        url: await github(
          githubAppUsers.authorize(c.req.param("id"), new URL(origin).origin),
        ),
      },
      200,
    );
  });
  register(routes.completeGithubAppSignIn, async (c) => {
    const input = githubAppCompleteInput.parse(await c.req.json());

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

    const { clientSecret } = githubAppClientSecretInput.parse(
      await c.req.json(),
    );

    return c.json(
      await github(
        githubAppUsers
          .setClientSecret(id, clientSecret)
          .pipe(Effect.andThen(githubApps.get(id))),
      ),
      200,
    );
  });

  register(routes.githubAccounts, async (c) =>
    c.json({ accounts: await github(githubAccounts.list) }, 200),
  );
  register(routes.addGithubAccount, async (c) => {
    const { token } = githubAccountTokenInput.parse(await c.req.json());

    return c.json(await github(githubAccounts.add(token)), 200);
  });
  register(routes.setGithubAccountToken, async (c) => {
    const { token } = githubAccountTokenInput.parse(await c.req.json());

    return c.json(
      await github(githubAccounts.setToken(c.req.param("id"), token)),
      200,
    );
  });
  register(routes.setGithubAccountBots, async (c) => {
    const botIds = botIdsOf(githubBotsInput.parse(await c.req.json()).botIds);

    return c.json(
      await github(
        githubAccounts.assign(c.req.param("id"), botIds).pipe(
          Effect.tap(({ changed }) => githubApps.sync(changed)),
          Effect.map(({ account }) => account),
        ),
      ),
      200,
    );
  });
  register(routes.deleteGithubAccount, async (c) => {
    await github(
      githubAccounts
        .remove(c.req.param("id"))
        .pipe(Effect.flatMap(githubApps.sync)),
    );

    return c.body(null, 204);
  });
}
