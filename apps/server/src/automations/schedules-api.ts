import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { ScheduleRepository } from "./schedule-repository";
import { Scheduler } from "./scheduler";
import { ScriptRuns } from "./script-runs";

type Services = ScheduleRepository | Scheduler | ScriptRuns;

/** The schedules one bot or the owner created, and running one now. */
export function registerScheduleRoutes(options: {
  register: Register;
  run: Runner<Services>;
}) {
  const { register, run } = options;

  const assertSchedule = (id: string) => {
    if (!run.runSync(ScheduleRepository.use((r) => r.get(id))))
      throw new NotFound({ message: "Schedule not found" });
  };

  register(routes.schedules, (c) =>
    c.json(
      run.runSync(
        ScheduleRepository.use((r) => r.list(c.req.query("agentId"))),
      ),
      200,
    ),
  );
  register(routes.createSchedule, async (c) =>
    c.json(
      await run.runPromise(Scheduler.use((s) => s.create(c.req.valid("json")))),
      201,
    ),
  );
  register(
    routes.updateSchedule,
    async (c) => {
      const id = c.req.param("id");

      // Before the body: an unknown schedule answers 404 even when the body is not JSON.
      assertSchedule(id);

      const input = await c.req.json();

      return c.json(
        await run.runPromise(Scheduler.use((s) => s.update(id, input))),
        200,
      );
    },
    { parsesBody: true },
  );
  register(routes.deleteSchedule, (c) => {
    if (
      !run.runSync(ScheduleRepository.use((r) => r.delete(c.req.param("id"))))
    )
      throw new NotFound({ message: "Schedule not found" });

    return c.body(null, 204);
  });
  register(routes.runSchedule, async (c) => {
    return c.json(
      await run.runPromise(Scheduler.use((s) => s.runNow(c.req.param("id")))),
      202,
    );
  });
  register(routes.listScriptRuns, async (c) => {
    const id = c.req.param("id");

    assertSchedule(id);

    return c.json(
      await run.runPromise(
        ScriptRuns.use((s) => s.list(id, c.req.valid("query"))),
      ),
      200,
    );
  });
}
