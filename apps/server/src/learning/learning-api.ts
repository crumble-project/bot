import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotsAccess } from "../bots/bots";
import { NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { ChangeReverter } from "./change-reverter";
import { LearnedChangeRepository } from "./learned-change-repository";

/** The learned changes the bot's reviews produced, and the owner reverting one. */
export function registerLearningRoutes(options: {
  register: Register;
  service: BotsAccess;
  run: Runner<ChangeReverter | LearnedChangeRepository>;
}) {
  const { register, service, run } = options;

  register(routes.agentReviews, (c) =>
    c.json(
      run.runSync(
        LearnedChangeRepository.use((r) =>
          r.listReviewResults(
            service.agent(c.req.param("id")).id,
            c.req.valid("query").limit,
          ),
        ),
      ),
      200,
    ),
  );
  register(routes.changes, (c) => {
    const query = c.req.valid("query");

    if (query.agentId && query.agentId !== "shared")
      service.agent(query.agentId);

    return c.json(
      run.runSync(
        LearnedChangeRepository.use((r) =>
          r.list(query.agentId === "shared" ? null : query.agentId, {
            limit: query.limit,
            before: query.before,
          }),
        ),
      ),
      200,
    );
  });
  register(routes.revertChange, (c) => {
    const reverted = run.runSync(
      ChangeReverter.use((r) =>
        r.revert(c.req.param("id"), { actor: "owner" }),
      ),
    );

    if (!reverted) throw new NotFound({ message: "Change not found" });

    return c.json(reverted, 201);
  });
}
