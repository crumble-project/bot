import type { Env } from "hono";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { ExecutionRepository } from "../bot-store/execution-repository";

export function registerExecutionRoutes(options: {
  register: Register<Env, ExecutionRepository>;
}) {
  const { register } = options;

  register(routes.executions, function* (c) {
    const executions = yield* ExecutionRepository;

    return c.json(yield* executions.list(c.req.query("agentId")), 200);
  });
}
