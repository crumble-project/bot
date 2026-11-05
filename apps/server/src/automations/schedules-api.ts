import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { ExecutionRepository } from "../bots/execution-repository";
import { NotFound } from "../shared/errors";
import { AgentRepository } from "../bots/agent-repository";
import type { ScriptRuns } from "./script-runs";
import type { Runner } from "../shared/runner";
import { ScheduleRepository } from "./schedule-repository";
import type { SchedulerAccess } from "./scheduler";

type Services = AgentRepository | ExecutionRepository | ScheduleRepository;

type Exec = Runner<Services>["runSync"];

/** The schedules one bot or the owner created, and running one now. */
export function registerScheduleRoutes(options: {
  register: Register;
  run: Runner<Services>;
  scheduler: SchedulerAccess;
  scriptRuns: ScriptRuns["Service"];
}) {
  const { register, scheduler } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  const assertSchedule = (id: string) => {
    if (!exec(ScheduleRepository.use((r) => r.get(id))))
      throw new NotFound({ message: "Schedule not found" });
  };

  register(routes.schedules, (c) =>
    c.json(
      exec(ScheduleRepository.use((r) => r.list(c.req.query("agentId")))),
      200,
    ),
  );
  register(routes.createSchedule, (c) =>
    c.json(scheduler.create(c.req.valid("json")), 201),
  );
  register(
    routes.updateSchedule,
    async (c) => {
      const id = c.req.param("id");

      // Before the body: an unknown schedule answers 404 even when the body is not JSON.
      assertSchedule(id);

      return c.json(scheduler.update(id, await c.req.json()), 200);
    },
    { parsesBody: true },
  );
  register(routes.deleteSchedule, (c) => {
    if (!exec(ScheduleRepository.use((r) => r.delete(c.req.param("id")))))
      throw new NotFound({ message: "Schedule not found" });

    return c.body(null, 204);
  });
  register(routes.runSchedule, async (c) => {
    return c.json(await scheduler.runNow(c.req.param("id")), 202);
  });
  register(routes.listScriptRuns, async (c) => {
    const id = c.req.param("id");

    assertSchedule(id);

    return c.json(
      await options.run.runPromise(
        options.scriptRuns.list(id, c.req.valid("query")),
      ),
      200,
    );
  });
  register(routes.executions, (c) =>
    c.json(
      exec(ExecutionRepository.use((r) => r.list(c.req.query("agentId")))),
      200,
    ),
  );
}
