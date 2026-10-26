import type { z } from "zod";
import { routes } from "../contract/api-contract";
import type { scheduleRunResponse } from "../contract/api-responses";
import type { Register } from "../contract/route";
import { ExecutionRepository } from "../bots/execution-repository";
import type { CoreServices } from "../shared/core-layer";
import { scheduleInput } from "../shared/domain";
import { NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import { ScheduleRepository } from "./schedule-repository";
import type { SchedulerAccess } from "./scheduler";

type Exec = Runner<CoreServices>["runSync"];

/** The schedules one bot or the owner created, and running one now. */
export function registerScheduleRoutes(options: {
  register: Register;
  run: Runner<CoreServices>;
  scheduler: SchedulerAccess;
}) {
  const { register, scheduler } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.schedules, (c) =>
    c.json(
      exec(ScheduleRepository.use((r) => r.list(c.req.query("agentId")))),
      200,
    ),
  );
  register(routes.createSchedule, async (c) =>
    c.json(scheduler.create(scheduleInput.parse(await c.req.json())), 201),
  );
  register(routes.updateSchedule, async (c) => {
    const old = exec(ScheduleRepository.use((r) => r.get(c.req.param("id"))));

    if (!old) throw new NotFound({ message: "Schedule not found" });

    return c.json(
      scheduler.update(
        old.id,
        scheduleInput.parse({ ...old, ...(await c.req.json()) }),
      ),
      200,
    );
  });
  register(routes.deleteSchedule, (c) => {
    if (!exec(ScheduleRepository.use((r) => r.delete(c.req.param("id")))))
      throw new NotFound({ message: "Schedule not found" });

    return c.body(null, 204);
  });
  register(routes.runSchedule, async (c) => {
    const run = await scheduler.runNow(c.req.param("id"));

    const body: z.output<typeof scheduleRunResponse> = {
      ...run,
      result: run.result ?? undefined,
    };

    return c.json(body, 202);
  });
  register(routes.executions, (c) =>
    c.json(
      exec(ExecutionRepository.use((r) => r.list(c.req.query("agentId")))),
      200,
    ),
  );
}
