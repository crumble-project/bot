import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { ScheduleRepository } from "./schedule-repository";
import { Scheduler } from "./scheduler";
import { ScriptRuns } from "./script-runs";

type Services = ScheduleRepository | Scheduler | ScriptRuns;

type ScheduleRoutesOptions = {
  register: Register;
  run: Runner<Services>;
};

const assertSchedule = (run: Runner<Services>, id: string) => {
  if (!run.runSync(ScheduleRepository.use((r) => r.get(id))))
    throw new NotFound({ message: "Schedule not found" });
};

const registerScheduleEditRoutes = ({
  register,
  run,
}: ScheduleRoutesOptions) => {
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

      assertSchedule(run, id);

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
};

const registerScheduleRunRoutes = ({
  register,
  run,
}: ScheduleRoutesOptions) => {
  register(routes.runSchedule, async (c) => {
    return c.json(
      await run.runPromise(Scheduler.use((s) => s.runNow(c.req.param("id")))),
      202,
    );
  });
  register(routes.listScriptRuns, async (c) => {
    const id = c.req.param("id");

    assertSchedule(run, id);

    return c.json(
      await run.runPromise(
        ScriptRuns.use((s) => s.list(id, c.req.valid("query"))),
      ),
      200,
    );
  });
};

export function registerScheduleRoutes(options: ScheduleRoutesOptions) {
  registerScheduleEditRoutes(options);
  registerScheduleRunRoutes(options);
}
