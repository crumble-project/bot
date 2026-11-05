import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import type { Runner } from "../shared/runner";
import { ExecutionRepository } from "./execution-repository";

/** Every turn the account's bots ran, newest state first, optionally for one bot. */
export function registerExecutionRoutes(options: {
  register: Register;
  run: Runner<ExecutionRepository>;
}) {
  const { register, run } = options;

  register(routes.executions, (c) =>
    c.json(
      run.runSync(
        ExecutionRepository.use((r) => r.list(c.req.query("agentId"))),
      ),
      200,
    ),
  );
}
