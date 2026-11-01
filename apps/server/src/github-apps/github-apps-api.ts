import { Effect } from "effect";
import { routes } from "../contract/api-contract";
import {
  githubAppCompleteInput,
  githubAppManifestInput,
} from "../contract/github-apps";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import type { Runner } from "../shared/runner";
import { Unavailable } from "../shared/errors";
import { GitHubAppUnavailable, GitHubApps } from "./github-apps";

/** Creating, installing, and removing each bot's GitHub App. */
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

  register(routes.agentGithubApp, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(
      { app: (await apps((a) => a.get(c.req.param("id")))) ?? null },
      200,
    );
  });
  register(routes.createAgentGithubAppManifest, async (c) => {
    const agent = service.agent(c.req.param("id"));
    const input = githubAppManifestInput.parse(await c.req.json());

    return c.json(
      await apps((a) =>
        a.manifest(agent.id, {
          botName: agent.name,
          origin: new URL(input.origin).origin,
          organization: input.organization,
        }),
      ),
      200,
    );
  });
  register(routes.completeAgentGithubApp, async (c) => {
    service.agent(c.req.param("id"));
    const input = githubAppCompleteInput.parse(await c.req.json());

    return c.json(await apps((a) => a.complete(c.req.param("id"), input)), 200);
  });
  register(routes.connectAgentGithubApp, async (c) => {
    service.agent(c.req.param("id"));

    return c.json(await apps((a) => a.connect(c.req.param("id"))), 200);
  });
  register(routes.deleteAgentGithubApp, async (c) => {
    service.agent(c.req.param("id"));
    await apps((a) => a.remove(c.req.param("id")));

    return c.body(null, 204);
  });
}
