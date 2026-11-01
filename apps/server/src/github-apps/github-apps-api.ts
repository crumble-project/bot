import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import {
  githubAppBotsInput,
  githubAppCompleteInput,
  githubAppManifestInput,
} from "../contract/github-apps";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import type { Runner } from "../shared/runner";
import { Unavailable } from "../shared/errors";
import { GitHubAppUnavailable, GitHubApps } from "./github-apps";

/** The account's GitHub Apps: creating, installing, assigning to bots, and removing them. */
export function registerGitHubAppRoutes(options: {
  register: Register;
  service: BotsAccess;
  run: Runner<GitHubApps>;
}) {
  const { register, service, run } = options;
  const githubApps = run.runSync(GitHubApps.use(Effect.succeed));

  // GitHub being unreachable is the server's problem to report, not a defect.
  const apps = <A, E>(
    use: (apps: GitHubApps["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.runPromise(
      use(githubApps).pipe(
        Effect.mapError((error) =>
          error instanceof GitHubAppUnavailable
            ? new Unavailable({ message: error.message })
            : error,
        ),
      ),
    );

  register(routes.githubApps, async (c) =>
    c.json({ apps: await apps((a) => a.list) }, 200),
  );
  register(routes.createGithubAppManifest, async (c) => {
    const input = githubAppManifestInput.parse(await c.req.json());

    return c.json(
      await apps((a) =>
        a.manifest({ ...input, origin: new URL(input.origin).origin }),
      ),
      200,
    );
  });
  register(routes.completeGithubApp, async (c) => {
    const input = githubAppCompleteInput.parse(await c.req.json());

    return c.json(await apps((a) => a.complete(input)), 200);
  });
  register(routes.connectGithubApp, async (c) =>
    c.json(await apps((a) => a.connect(c.req.param("id"))), 200),
  );
  register(routes.setGithubAppBots, async (c) => {
    const { botIds } = githubAppBotsInput.parse(await c.req.json());

    for (const botId of botIds) service.agent(botId);

    return c.json(
      await apps((a) => a.assign(c.req.param("id"), [...new Set(botIds)])),
      200,
    );
  });
  register(routes.deleteGithubApp, async (c) => {
    await apps((a) => a.remove(c.req.param("id")));

    return c.body(null, 204);
  });
}
