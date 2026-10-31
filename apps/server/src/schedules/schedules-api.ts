import type { z } from "zod";
import { routes, scriptRunsInput } from "../contract/api-contract";
import type { scheduleRunResponse } from "../contract/api-responses";
import type { Register } from "../contract/route";
import { ExecutionRepository } from "../bots/execution-repository";
import {
  mergeScheduleInput,
  scheduleInput,
  type ScheduleInput,
} from "../shared/domain";
import { Conflict, Forbidden, NotFound, Unavailable } from "../shared/errors";
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
  coding?: boolean | undefined;
  scriptRuns?: ScriptRuns["Service"] | undefined;
}) {
  const { register, scheduler } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  const scriptPolicy = (
    input: ScheduleInput,
    createdByAgentId: string | null = null,
  ) => {
    if (input.kind !== "script") return;
    const agent = exec(AgentRepository.use((r) => r.get(input.agentId)));

    if (!agent) throw new NotFound({ message: "Agent not found" });

    if (!agent.tools.includes("coding"))
      throw new Forbidden({ message: "Script tasks need coding jobs" });

    if (createdByAgentId && createdByAgentId !== input.agentId)
      throw new Forbidden({
        message: "You can only give yourself a script task",
      });

    if (options.coding !== true)
      throw new Conflict({ message: "This server has no workspaces" });
  };

  register(routes.schedules, (c) =>
    c.json(
      exec(ScheduleRepository.use((r) => r.list(c.req.query("agentId")))),
      200,
    ),
  );
  register(routes.createSchedule, async (c) => {
    const input = scheduleInput.parse(await c.req.json());
    scriptPolicy(input);

    return c.json(scheduler.create(input), 201);
  });
  register(routes.updateSchedule, async (c) => {
    const old = exec(ScheduleRepository.use((r) => r.get(c.req.param("id"))));

    if (!old) throw new NotFound({ message: "Schedule not found" });

    const input = scheduleInput.parse(
      mergeScheduleInput(old, await c.req.json()),
    );

    scriptPolicy(input, old.createdByAgentId);

    return c.json(scheduler.update(old.id, input), 200);
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
  register(routes.listScriptRuns, async (c) => {
    const id = c.req.param("id");

    if (!exec(ScheduleRepository.use((r) => r.get(id))))
      throw new NotFound({ message: "Schedule not found" });

    const query = scriptRunsInput.parse(c.req.query());

    if (!options.scriptRuns)
      throw new Unavailable({ message: "Script runs are unavailable" });

    return c.json(
      await options.run.runPromise(options.scriptRuns.list(id, query)),
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
