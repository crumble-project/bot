import { Effect } from "effect";
import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { BotLookup } from "../bot-ports/bot-lookup";
import { NotFound } from "../shared/errors";
import { ChangeReverter } from "./change-reverter";
import { LearnedChangeRepository } from "../learned-changes/learned-change-repository";

export function registerLearningRoutes(options: {
  register: Register<Env, ChangeReverter | LearnedChangeRepository>;
  service: BotLookup;
}) {
  const { register, service } = options;

  register(routes.agentReviews, function* (c) {
    const changes = yield* LearnedChangeRepository;

    return c.json(
      yield* changes.listReviewResults(
        service.agent(c.req.param("id")).id,
        c.req.valid("query").limit,
      ),
      200,
    );
  });
  register(routes.changes, function* (c) {
    const query = c.req.valid("query");

    if (query.agentId && query.agentId !== "shared")
      service.agent(query.agentId);
    const changes = yield* LearnedChangeRepository;

    return c.json(
      yield* changes.list(query.agentId === "shared" ? null : query.agentId, {
        limit: query.limit,
        before: query.before,
      }),
      200,
    );
  });
  register(routes.revertChange, function* (c) {
    const reverter = yield* ChangeReverter;

    const reverted = yield* reverter.revert(c.req.param("id"), {
      actor: "owner",
    });

    if (!reverted)
      return yield* Effect.fail(new NotFound({ message: "Change not found" }));

    return c.json(reverted, 201);
  });
}
