import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  AppError,
  type Agent,
  type Schedule,
  type ScheduleInput,
} from "../shared/domain";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { Runner } from "../shared/runner";
import { TaskDispatch, type ScheduleDispatchResult } from "./task-dispatch";
import { AgentRepository } from "../bots/agent-repository";
import { ScheduleRepository } from "./schedule-repository";
import { Scheduler, schedulerAccess } from "./scheduler";

const output = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export type ScheduleDraft = {
  agentId?: string | undefined;
  name?: string | undefined;
  prompt?: string | undefined;
  cron?: string | null | undefined;
  runAt?: string | null | undefined;
  timezone?: string | null | undefined;
  enabled?: boolean | undefined;
};

type PresentedTask = {
  id: string;
  agentId: string;
  agentName: string;
  name: string;
  prompt: string;
  cron: string | null;
  timezone: string;
  runAt: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  createdByAgentId: string | null;
};

const visible = (source: Agent, schedule: Schedule) =>
  schedule.agentId === source.id || schedule.createdByAgentId === source.id;

const when = (
  draft: ScheduleDraft,
  cron: string | null,
  runAt: string | null,
): Effect.Effect<Pick<ScheduleInput, "cron" | "runAt">, AppError> => {
  const nextCron = draft.cron?.trim() ?? "";
  const nextRun = draft.runAt?.trim() ?? "";

  if (nextCron && nextRun)
    return Effect.fail(
      new AppError(400, "Choose a recurring cron or a one-time date"),
    );

  if (nextCron) return Effect.succeed({ cron: nextCron, runAt: null });

  if (nextRun) return Effect.succeed({ cron: null, runAt: nextRun });

  const kept = {
    cron: draft.cron !== undefined ? null : cron,
    runAt: draft.runAt !== undefined ? null : runAt,
  };

  if (!kept.cron && !kept.runAt)
    return Effect.fail(
      new AppError(400, "Choose a recurring cron or a one-time date"),
    );

  return Effect.succeed(kept);
};

/** Tasks a bot may see or change. Each task runs in one bot's chat. */
export class BotSchedules extends Context.Service<
  BotSchedules,
  {
    readonly list: (
      sourceId: string,
    ) => Effect.Effect<PresentedTask[], AppError>;
    readonly create: (
      sourceId: string,
      draft: ScheduleDraft,
    ) => Effect.Effect<PresentedTask, AppError>;
    readonly update: (
      sourceId: string,
      id: string,
      draft: ScheduleDraft,
    ) => Effect.Effect<PresentedTask, AppError>;
    readonly delete: (
      sourceId: string,
      id: string,
    ) => Effect.Effect<{ deleted: true; id: string }, AppError>;
    readonly run: (
      sourceId: string,
      id: string,
    ) => Effect.Effect<
      {
        admitted: boolean;
        executionId: string | null;
        status: string | null;
      },
      unknown
    >;
  }
>()("crumble/schedules/BotSchedules") {
  static readonly layer = Layer.effect(
    BotSchedules,
    Effect.gen(function* () {
      const agents = yield* AgentRepository;
      const schedules = yield* ScheduleRepository;
      const scheduler = yield* Scheduler;

      const source = Effect.fnUntraced(function* (id: string) {
        const agent = yield* agents.get(id);

        if (!agent?.enabled || !agent.tools.includes("schedule"))
          return yield* Effect.fail(
            new AppError(403, "Scheduling is turned off for this bot"),
          );

        return agent;
      });

      /** A bot may assign work to itself, or to a bot it is allowed to message. */
      const target = Effect.fnUntraced(function* (
        from: Agent,
        agentId: string | undefined,
      ) {
        const id = agentId?.trim() || from.id;

        if (
          id !== from.id &&
          !(from.tools.includes("delegate") && from.delegates.includes(id))
        )
          return yield* Effect.fail(
            new AppError(
              403,
              "You can schedule a task for yourself, or for a bot you are allowed to message",
            ),
          );
        const targeted = yield* agents.get(id);

        if (!targeted)
          return yield* Effect.fail(new AppError(404, "Bot not found"));

        if (id !== from.id && !targeted.enabled)
          return yield* Effect.fail(new AppError(409, "That bot is disabled"));

        return targeted.id;
      });

      const manageable = Effect.fnUntraced(function* (from: Agent, id: string) {
        const schedule = yield* schedules.get(id);

        if (!schedule || !visible(from, schedule))
          return yield* Effect.fail(new AppError(404, "Task not found"));

        return schedule;
      });

      const present = Effect.fnUntraced(function* (schedule: Schedule) {
        const task: PresentedTask = {
          id: schedule.id,
          agentId: schedule.agentId,
          agentName: (yield* agents.get(schedule.agentId))?.name ?? "",
          name: schedule.name,
          prompt: schedule.prompt,
          cron: schedule.cron,
          timezone: schedule.timezone,
          runAt: schedule.runAt,
          enabled: schedule.enabled,
          nextRunAt: schedule.nextRunAt,
          createdByAgentId: schedule.createdByAgentId,
        };

        return task;
      });

      const list = Effect.fn("BotSchedules.list")(function* (sourceId: string) {
        const from = yield* source(sourceId);

        return yield* Effect.forEach(
          (yield* schedules.list()).filter((schedule) =>
            visible(from, schedule),
          ),
          present,
        );
      });

      const create = Effect.fn("BotSchedules.create")(function* (
        sourceId: string,
        draft: ScheduleDraft,
      ) {
        const from = yield* source(sourceId);
        const name = draft.name?.trim() ?? "";
        const prompt = draft.prompt?.trim() ?? "";

        if (!name || !prompt)
          return yield* Effect.fail(
            new AppError(400, "Task name and prompt are required"),
          );
        const agentId = yield* target(from, draft.agentId);

        const schedule = yield* scheduler.create(
          {
            agentId,
            name,
            prompt,
            ...(yield* when(draft, null, null)),
            timezone: draft.timezone?.trim() || "UTC",
            enabled: draft.enabled ?? true,
          },
          from.id,
        );

        return yield* present(schedule);
      });

      const update = Effect.fn("BotSchedules.update")(function* (
        sourceId: string,
        id: string,
        draft: ScheduleDraft,
      ) {
        const from = yield* source(sourceId);
        const existing = yield* manageable(from, id);
        const requested = draft.agentId?.trim();

        const agentId =
          requested && requested !== existing.agentId
            ? yield* target(from, requested)
            : requested || existing.agentId;

        const timing = yield* when(draft, existing.cron, existing.runAt);

        const schedule = yield* scheduler.update(existing.id, {
          agentId,
          name: draft.name?.trim() || existing.name,
          prompt: draft.prompt?.trim() || existing.prompt,
          timezone: draft.timezone?.trim() || existing.timezone,
          enabled: draft.enabled ?? existing.enabled,
          ...timing,
        });

        if (!schedule)
          return yield* Effect.fail(new AppError(404, "Task not found"));

        return yield* present(schedule);
      });

      const remove = Effect.fn("BotSchedules.delete")(function* (
        sourceId: string,
        id: string,
      ) {
        const from = yield* source(sourceId);
        const existing = yield* manageable(from, id);

        if (!(yield* schedules.delete(existing.id)))
          return yield* Effect.fail(new AppError(404, "Task not found"));

        return { deleted: true as const, id: existing.id };
      });

      const run = Effect.fn("BotSchedules.run")(function* (
        sourceId: string,
        id: string,
      ) {
        const from = yield* source(sourceId);
        const existing = yield* manageable(from, id);
        const ran = yield* scheduler.runNow(existing.id);
        const execution = ran.result;

        return {
          admitted: ran.admitted,
          executionId: execution?.id != null ? String(execution.id) : null,
          status: execution?.status != null ? String(execution.status) : null,
        };
      });

      return BotSchedules.of({ list, create, update, delete: remove, run });
    }),
  );
}

/** Model tool for the schedule capability. Policy lives in `BotSchedules`. */
export function scheduleExtension(
  agent: Agent,
  schedules: BotSchedules["Service"],
) {
  const schedule = defineTool({
    name: "schedule",
    description:
      "Create, list, update, delete, or run a task that targets one bot. The task runs in that bot's chat, once at runAt (ISO-8601 with Z for UTC or an explicit offset, e.g. 2026-10-18T12:10:00+02:00) or on a cron schedule. timezone controls cron only; it does not change the instant in runAt. Use the owner's known timezone for local times; ask if unknown. Omit agentId to target yourself. Pass another bot's ID only when you are allowed to message it. You can change tasks that run on you and tasks you created. A task exists only after this tool saves it. Use enabled to pause or resume.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"),
        Type.Literal("create"),
        Type.Literal("update"),
        Type.Literal("delete"),
        Type.Literal("run"),
      ]),
      id: Type.Optional(Type.String({ minLength: 1 })),
      agentId: Type.Optional(Type.String({ minLength: 1 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
      cron: Type.Optional(Type.String({ maxLength: 100 })),
      runAt: Type.Optional(Type.String({ maxLength: 40 })),
      timezone: Type.Optional(Type.String({ maxLength: 100 })),
      enabled: Type.Optional(Type.Boolean()),
    }),
    replay: "unsafe",
    execute: async (args) => {
      const draft: ScheduleDraft = {
        agentId: args.agentId,
        name: args.name,
        prompt: args.prompt,
        cron: args.cron,
        runAt: args.runAt,
        timezone: args.timezone,
        enabled: args.enabled,
      };

      if (args.action === "list")
        return output(await Effect.runPromise(schedules.list(agent.id)));

      if (!args.id && args.action !== "create")
        throw new AppError(400, "Task ID is required");

      if (args.action === "create")
        return output(
          await Effect.runPromise(schedules.create(agent.id, draft)),
        );

      if (args.action === "update")
        return output(
          await Effect.runPromise(schedules.update(agent.id, args.id!, draft)),
        );

      if (args.action === "delete")
        return output(
          await Effect.runPromise(schedules.delete(agent.id, args.id!)),
        );

      return output(await Effect.runPromise(schedules.run(agent.id, args.id!)));
    },
  });

  return defineExtension({
    name: "schedule",
    tools: agent.tools.includes("schedule") ? [schedule] : [],
  });
}

/** Bot schedules for code outside Effect, with errors thrown as before. */
export type BotSchedulesAccess = {
  list(sourceId: string): PresentedTask[];
  create(sourceId: string, draft: ScheduleDraft): PresentedTask;
  update(sourceId: string, id: string, draft: ScheduleDraft): PresentedTask;
  delete(sourceId: string, id: string): { deleted: true; id: string };
  run(
    sourceId: string,
    id: string,
  ): Promise<{
    admitted: boolean;
    executionId: string | null;
    status: string | null;
  }>;
};

export const botSchedulesAccess = (
  schedules: BotSchedules["Service"],
): BotSchedulesAccess => ({
  list: (sourceId) => Effect.runSync(schedules.list(sourceId)),
  create: (sourceId, draft) =>
    Effect.runSync(schedules.create(sourceId, draft)),
  update: (sourceId, id, draft) =>
    Effect.runSync(schedules.update(sourceId, id, draft)),
  delete: (sourceId, id) => Effect.runSync(schedules.delete(sourceId, id)),
  run: (sourceId, id) => Effect.runPromise(schedules.run(sourceId, id)),
});

/** Bot schedules and their scheduler over the tasks `core` reaches, for a test without an account. */
export function standaloneBotSchedules(
  core: Runner<ScheduleRepository | AgentRepository>,
  dispatch: (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) => Promise<ScheduleDispatchResult>,
) {
  const runtime = ManagedRuntime.make(
    BotSchedules.layer.pipe(
      Layer.provideMerge(Scheduler.layer()),
      Layer.provide(
        Layer.succeed(TaskDispatch, (agentId, prompt, requestId, scheduleId) =>
          Effect.tryPromise({
            try: () => dispatch(agentId, prompt, requestId, scheduleId),
            catch: (error) => error,
          }),
        ),
      ),
      Layer.provide(
        Layer.succeedContext(
          core.runSync(Effect.context<ScheduleRepository | AgentRepository>()),
        ),
      ),
    ),
  );

  const service = runtime.runSync(BotSchedules.use(Effect.succeed));

  return {
    service,
    schedules: botSchedulesAccess(service),
    scheduler: schedulerAccess(runtime),
  };
}
