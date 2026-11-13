import { Effect } from "effect";
import type { Env } from "hono";
import { z } from "zod";
import { EventRepository } from "../event-sources/event-repository";
import { scheduleDescription, previewSchedule } from "./schedule-description";
import { routes } from "../contract/api-contract";
import type { Register } from "../contract/route";
import { scheduleInput, type Schedule } from "../contract/schedules";
import { NotFound } from "../shared/errors";
import { ScheduleRepository } from "./schedule-repository";
import { Scheduler } from "./scheduler";
import { ScriptRuns } from "./script-runs";

const schedulePatch = z.object({
  agentId: z.exactOptional(scheduleInput.shape.agentId),
  name: z.exactOptional(scheduleInput.shape.name),
  kind: z.exactOptional(scheduleInput.shape.kind.unwrap()),
  prompt: z.exactOptional(scheduleInput.shape.prompt.unwrap()),
  command: z.exactOptional(scheduleInput.shape.command.unwrap()),
  timeoutSeconds: z.exactOptional(scheduleInput.shape.timeoutSeconds.unwrap()),
  notify: z.exactOptional(scheduleInput.shape.notify.unwrap()),
  cron: z.exactOptional(scheduleInput.shape.cron.unwrap()),
  timezone: z.exactOptional(scheduleInput.shape.timezone.unwrap()),
  runAt: z.exactOptional(scheduleInput.shape.runAt.unwrap()),
  eventSourceId: z.exactOptional(scheduleInput.shape.eventSourceId.unwrap()),
  enabled: z.exactOptional(scheduleInput.shape.enabled.unwrap()),
});

type ScheduleRoutesOptions = {
  register: Register<
    Env,
    ScheduleRepository | Scheduler | ScriptRuns | EventRepository
  >;
};

const assertSchedule = Effect.fnUntraced(function* (id: string) {
  const schedules = yield* ScheduleRepository;

  if (!(yield* schedules.get(id)))
    return yield* Effect.fail(new NotFound({ message: "Schedule not found" }));
});

const sourceName = Effect.fnUntraced(function* (
  sourceId: string | null | undefined,
) {
  if (!sourceId) return;
  const events = yield* EventRepository;
  const source = yield* events.getSource(sourceId);

  return source?.name;
});

const scheduleWithDescription = Effect.fnUntraced(function* (
  schedule: Schedule,
) {
  return scheduleDescription(
    schedule,
    yield* sourceName(schedule.eventSourceId),
  );
});

const registerScheduleEditRoutes = ({ register }: ScheduleRoutesOptions) => {
  register(routes.schedules, function* (c) {
    const scheduleRepo = yield* ScheduleRepository;
    const events = yield* EventRepository;
    const schedules = yield* scheduleRepo.list(c.req.query("agentId"));
    const sources = yield* events.listSources;

    return c.json(
      schedules.map((schedule) =>
        scheduleDescription(
          schedule,
          sources.find((source) => source.id === schedule.eventSourceId)?.name,
        ),
      ),
      200,
    );
  });
  register(routes.previewSchedule, function* (c) {
    const input = c.req.valid("json");

    return c.json(
      previewSchedule(input, yield* sourceName(input.eventSourceId)),
      200,
    );
  });
  register(routes.createSchedule, function* (c) {
    const scheduler = yield* Scheduler;
    const schedule = yield* scheduler.create(c.req.valid("json"));

    return c.json(yield* scheduleWithDescription(schedule), 201);
  });
  register(
    routes.updateSchedule,
    function* (c) {
      const id = c.req.param("id");
      yield* assertSchedule(id);

      const input = schedulePatch.parse(
        yield* Effect.promise(() => c.req.json()),
      );

      const scheduler = yield* Scheduler;
      const schedule = yield* scheduler.update(id, input);

      if (!schedule) return c.json(null, 200);

      return c.json(yield* scheduleWithDescription(schedule), 200);
    },
    { parsesBody: true },
  );
  register(routes.deleteSchedule, function* (c) {
    const schedules = yield* ScheduleRepository;

    if (!(yield* schedules.delete(c.req.param("id"))))
      return yield* Effect.fail(
        new NotFound({ message: "Schedule not found" }),
      );

    return c.body(null, 204);
  });
};

const registerScheduleRunRoutes = ({ register }: ScheduleRoutesOptions) => {
  register(routes.runSchedule, function* (c) {
    const scheduler = yield* Scheduler;

    return c.json(yield* scheduler.runNow(c.req.param("id")), 202);
  });
  register(routes.listScriptRuns, function* (c) {
    const id = c.req.param("id");

    yield* assertSchedule(id);
    const scriptRuns = yield* ScriptRuns;

    return c.json(yield* scriptRuns.list(id, c.req.valid("query")), 200);
  });
};

export function registerScheduleRoutes(options: ScheduleRoutesOptions) {
  registerScheduleEditRoutes(options);
  registerScheduleRunRoutes(options);
}
