import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  type Agent,
  type Schedule,
  type ScheduleInput,
  type ScheduleKind,
} from "../shared/domain";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import type { Runner } from "../shared/runner";
import { AgentRepository } from "../bots/agent-repository";
import { ScheduleRepository } from "./schedule-repository";
import type { ScriptRuns } from "./script-runs";
import { BotWorkspaces, type Workspaces } from "../workspaces/workspace";
import {
  Scheduler,
  schedulerAccess,
  standaloneDependencies,
  type StandaloneDispatch,
} from "./scheduler";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import {
  InvalidInput,
  Forbidden,
  NotFound,
  Conflict,
  type AppError,
} from "../shared/errors";

const output = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export type ScheduleDraft = {
  agentId?: string | undefined;
  name?: string | undefined;
  prompt?: string | undefined;
  kind?: ScheduleKind | undefined;
  command?: string | null | undefined;
  timeoutSeconds?: number | undefined;
  notify?: boolean | undefined;
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
  kind: ScheduleKind;
  command: string | null;
  timeoutSeconds: number;
  notify: boolean;
  cron: string | null;
  timezone: string;
  runAt: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  createdByAgentId: string | null;
};

const presentedTaskSchema = Type.Object({
  id: Type.String(),
  agentId: Type.String(),
  agentName: Type.String(),
  name: Type.String(),
  prompt: Type.String(),
  kind: Type.Union([Type.Literal("prompt"), Type.Literal("script")]),
  command: Type.Union([Type.String(), Type.Null()]),
  timeoutSeconds: Type.Number(),
  notify: Type.Boolean(),
  cron: Type.Union([Type.String(), Type.Null()]),
  timezone: Type.String(),
  runAt: Type.Union([Type.String(), Type.Null()]),
  enabled: Type.Boolean(),
  nextRunAt: Type.Union([Type.String(), Type.Null()]),
  createdByAgentId: Type.Union([Type.String(), Type.Null()]),
});

const visible = (source: Agent, schedule: Schedule) =>
  schedule.agentId === source.id || schedule.createdByAgentId === source.id;

const retainedTiming = (
  draft: ScheduleDraft,
  cron: string | null,
  runAt: string | null,
) => ({
  cron: draft.cron !== undefined ? null : cron,
  runAt: draft.runAt !== undefined ? null : runAt,
});

const kindFields = (
  draft: ScheduleDraft,
  existing: Pick<
    ScheduleInput,
    "kind" | "command" | "timeoutSeconds" | "notify"
  > = {
    kind: "prompt",
    command: null,
    timeoutSeconds: 600,
    notify: true,
  },
) => {
  const kind = draft.kind ?? existing.kind;

  return {
    kind,
    command:
      draft.command !== undefined
        ? draft.command
        : kind === "script"
          ? existing.command
          : null,
    timeoutSeconds: draft.timeoutSeconds ?? existing.timeoutSeconds,
    notify: draft.notify ?? existing.notify,
  };
};

const updatedText = (draft: ScheduleDraft, existing: Schedule) => ({
  name: draft.name?.trim() || existing.name,
  prompt: draft.prompt?.trim() || existing.prompt,
  timezone: draft.timezone?.trim() || existing.timezone,
});

const requiredContent = Effect.fnUntraced(function* (
  draft: ScheduleDraft,
  kind: ScheduleKind,
) {
  const name = draft.name?.trim() ?? "";
  const prompt = draft.prompt?.trim() ?? "";

  if (!name || (kind === "prompt" && !prompt))
    return yield* new InvalidInput({
      message: "Task name and prompt are required",
    });

  return { name, prompt };
});

const when = (
  draft: ScheduleDraft,
  cron: string | null,
  runAt: string | null,
): Effect.Effect<Pick<ScheduleInput, "cron" | "runAt">, AppError> => {
  const nextCron = draft.cron?.trim() ?? "";
  const nextRun = draft.runAt?.trim() ?? "";

  if (nextCron && nextRun)
    return Effect.fail(
      new InvalidInput({
        message: "Choose a recurring cron or a one-time date",
      }),
    );

  if (nextCron) return Effect.succeed({ cron: nextCron, runAt: null });

  if (nextRun) return Effect.succeed({ cron: null, runAt: nextRun });

  const kept = retainedTiming(draft, cron, runAt);

  if (!kept.cron && !kept.runAt)
    return Effect.fail(
      new InvalidInput({
        message: "Choose a recurring cron or a one-time date",
      }),
    );

  return Effect.succeed(kept);
};

/** Tasks a bot may see or change. Each task targets one bot. */
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
      const workspaces = yield* BotWorkspaces;

      const scriptPolicy = Effect.fnUntraced(function* (
        from: Agent,
        agentId: string,
        createdByAgentId: string | null = null,
      ) {
        if (!from.tools.includes("coding"))
          return yield* new Forbidden({
            message: "Script tasks need coding jobs",
          });

        if (
          agentId !== from.id ||
          (createdByAgentId && createdByAgentId !== agentId)
        )
          return yield* new Forbidden({
            message: "You can only give yourself a script task",
          });

        if (workspaces === undefined)
          return yield* new Conflict({
            message: "This server has no workspaces",
          });
      });

      const source = Effect.fnUntraced(function* (id: string) {
        const agent = yield* agents.get(id);

        if (!agent?.enabled || !agent.tools.includes("schedule"))
          return yield* Effect.fail(
            new Forbidden({ message: "Scheduling is turned off for this bot" }),
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
            new Forbidden({
              message:
                "You can schedule a task for yourself, or for a bot you are allowed to message",
            }),
          );
        const targeted = yield* agents.get(id);

        if (!targeted)
          return yield* Effect.fail(new NotFound({ message: "Bot not found" }));

        if (id !== from.id && !targeted.enabled)
          return yield* Effect.fail(
            new Conflict({ message: "That bot is disabled" }),
          );

        return targeted.id;
      });

      const manageable = Effect.fnUntraced(function* (from: Agent, id: string) {
        const schedule = yield* schedules.get(id);

        if (!schedule || !visible(from, schedule))
          return yield* Effect.fail(
            new NotFound({ message: "Task not found" }),
          );

        return schedule;
      });

      const present = Effect.fnUntraced(function* (schedule: Schedule) {
        const task: PresentedTask = {
          id: schedule.id,
          agentId: schedule.agentId,
          agentName: (yield* agents.get(schedule.agentId))?.name ?? "",
          name: schedule.name,
          prompt: schedule.prompt,
          kind: schedule.kind,
          command: schedule.command,
          timeoutSeconds: schedule.timeoutSeconds,
          notify: schedule.notify,
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
        const fields = kindFields(draft);
        const { kind } = fields;

        if (kind === "script")
          yield* scriptPolicy(from, draft.agentId?.trim() || from.id);

        const content = yield* requiredContent(draft, kind);
        const agentId = yield* target(from, draft.agentId);

        const schedule = yield* scheduler.create(
          {
            agentId,
            ...content,
            ...fields,
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
        const fields = kindFields(draft, existing);
        const { kind } = fields;

        if (kind === "script")
          yield* scriptPolicy(
            from,
            requested || existing.agentId,
            existing.createdByAgentId,
          );

        const agentId =
          requested && requested !== existing.agentId
            ? yield* target(from, requested)
            : requested || existing.agentId;

        const timing = yield* when(draft, existing.cron, existing.runAt);

        const schedule = yield* scheduler.update(existing.id, {
          agentId,
          ...updatedText(draft, existing),
          ...fields,
          enabled: draft.enabled ?? existing.enabled,
          ...timing,
        });

        if (!schedule)
          return yield* Effect.fail(
            new NotFound({ message: "Task not found" }),
          );

        return yield* present(schedule);
      });

      const remove = Effect.fn("BotSchedules.delete")(function* (
        sourceId: string,
        id: string,
      ) {
        const from = yield* source(sourceId);
        const existing = yield* manageable(from, id);

        if (!(yield* schedules.delete(existing.id)))
          return yield* Effect.fail(
            new NotFound({ message: "Task not found" }),
          );

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
      "Create, list, update, delete, or run a task that targets one bot. The task runs in that bot's chat, once at runAt (ISO-8601 with Z for UTC or an explicit offset, e.g. 2026-10-18T12:10:00+02:00) or on a cron schedule. timezone controls cron only; it does not change the instant in runAt. Use the owner's known timezone for local times; ask if unknown. Omit agentId to target yourself. Pass another bot's ID only when you are allowed to message it. You can change tasks that run on you and tasks you created. A task exists only after this tool saves it. Use enabled to pause or resume. With kind script, the task runs command in your workspace (/workspace) on the schedule instead of sending a prompt, with your credentials; it runs only on you, needs coding jobs, and is killed after timeoutSeconds (default 600). With notify (default true) each run's result arrives in your chat.",
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
      kind: Type.Optional(
        Type.Union([Type.Literal("prompt"), Type.Literal("script")]),
      ),
      command: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      timeoutSeconds: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 3600 }),
      ),
      notify: Type.Optional(Type.Boolean()),
      cron: Type.Optional(Type.String({ maxLength: 100 })),
      runAt: Type.Optional(Type.String({ maxLength: 40 })),
      timezone: Type.Optional(Type.String({ maxLength: 100 })),
      enabled: Type.Optional(Type.Boolean()),
    }),
    structuredOutputSchema: Type.Union([
      presentedTaskSchema,
      Type.Array(presentedTaskSchema),
      Type.Object({ deleted: Type.Literal(true), id: Type.String() }),
      Type.Object({
        admitted: Type.Boolean(),
        executionId: Type.Union([Type.String(), Type.Null()]),
        status: Type.Union([Type.String(), Type.Null()]),
      }),
    ]),
    replay: "unsafe",
    execute: async (args) => {
      const draft: ScheduleDraft = {
        agentId: args.agentId,
        name: args.name,
        prompt: args.prompt,
        kind: args.kind,
        command: args.command,
        timeoutSeconds: args.timeoutSeconds,
        notify: args.notify,
        cron: args.cron,
        runAt: args.runAt,
        timezone: args.timezone,
        enabled: args.enabled,
      };

      if (args.action === "list")
        return output(await Effect.runPromise(schedules.list(agent.id)));

      if (!args.id && args.action !== "create")
        throw new InvalidInput({ message: "Task ID is required" });

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
  dispatch: StandaloneDispatch,
  scriptRuns?: ScriptRuns["Service"],
  workspaces?: Workspaces,
) {
  const runtime = ManagedRuntime.make(
    BotSchedules.layer.pipe(
      Layer.provideMerge(Scheduler.layer()),
      Layer.provide(standaloneDependencies(core, dispatch, scriptRuns)),
      Layer.provide(Layer.succeed(BotWorkspaces, workspaces)),
    ),
  );

  const service = runtime.runSync(BotSchedules.use(Effect.succeed));

  return {
    service,
    schedules: botSchedulesAccess(service),
    scheduler: schedulerAccess(runtime),
  };
}

/** Offers every bot the task tool. */
export const scheduleTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const schedules = yield* BotSchedules;

    yield* (yield* BotExtensions).register(
      ExtensionPosition.schedules,
      (agent) => [scheduleExtension(agent, schedules)],
    );
  }),
);
