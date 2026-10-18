import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
  AppError,
  type Agent,
  type Schedule,
  type ScheduleInput,
} from "./domain";
import type { Scheduler } from "./scheduler";
import type { Store } from "./store";

const output = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export type ScheduleDraft = {
  agentId?: string;
  name?: string;
  prompt?: string;
  cron?: string | null;
  runAt?: string | null;
  timezone?: string | null;
  enabled?: boolean;
};

/** Tasks a bot may see or change. Each task runs in one bot's chat. */
export class BotSchedules {
  constructor(
    private readonly store: Store,
    private readonly scheduler: Scheduler,
  ) {}

  list(sourceId: string) {
    const source = this.source(sourceId);
    return this.store
      .listSchedules()
      .filter((schedule) => this.visible(source, schedule))
      .map((schedule) => this.present(schedule));
  }

  create(sourceId: string, draft: ScheduleDraft) {
    const source = this.source(sourceId);
    const name = draft.name?.trim() ?? "";
    const prompt = draft.prompt?.trim() ?? "";
    if (!name || !prompt)
      throw new AppError(400, "Task name and prompt are required");
    const agentId = this.target(source, draft.agentId);
    const schedule = this.scheduler.create(
      {
        agentId,
        name,
        prompt,
        ...this.when(draft, null, null),
        timezone: draft.timezone?.trim() || "UTC",
        enabled: draft.enabled ?? true,
      },
      source.id,
    );
    return this.present(schedule);
  }

  update(sourceId: string, id: string, draft: ScheduleDraft) {
    const source = this.source(sourceId);
    const existing = this.manageable(source, id);
    const requested = draft.agentId?.trim();
    const agentId =
      requested && requested !== existing.agentId
        ? this.target(source, requested)
        : requested || existing.agentId;
    const timing = this.when(draft, existing.cron, existing.runAt);
    const schedule = this.scheduler.update(existing.id, {
      agentId,
      name: draft.name?.trim() || existing.name,
      prompt: draft.prompt?.trim() || existing.prompt,
      timezone: draft.timezone?.trim() || existing.timezone,
      enabled: draft.enabled ?? existing.enabled,
      ...timing,
    });
    if (!schedule) throw new AppError(404, "Task not found");
    return this.present(schedule);
  }

  delete(sourceId: string, id: string) {
    const source = this.source(sourceId);
    const existing = this.manageable(source, id);
    if (!this.store.deleteSchedule(existing.id))
      throw new AppError(404, "Task not found");
    return { deleted: true, id: existing.id };
  }

  async run(sourceId: string, id: string) {
    const source = this.source(sourceId);
    const existing = this.manageable(source, id);
    const ran = await this.scheduler.runNow(existing.id);
    const execution =
      ran.result && typeof ran.result === "object"
        ? (ran.result as { id?: unknown; status?: unknown })
        : null;
    return {
      admitted: ran.admitted,
      executionId: execution?.id != null ? String(execution.id) : null,
      status: execution?.status != null ? String(execution.status) : null,
    };
  }

  private source(id: string) {
    const agent = this.store.getAgent(id);
    if (!agent?.enabled || !agent.tools.includes("schedule"))
      throw new AppError(403, "Scheduling is turned off for this bot");
    return agent;
  }

  /** A bot may assign work to itself, or to a bot it is allowed to message. */
  private target(source: Agent, agentId: string | undefined) {
    const id = agentId?.trim() || source.id;
    if (
      id !== source.id &&
      !(source.tools.includes("delegate") && source.delegates.includes(id))
    )
      throw new AppError(
        403,
        "You can schedule a task for yourself, or for a bot you are allowed to message",
      );
    const target = this.store.getAgent(id);
    if (!target) throw new AppError(404, "Bot not found");
    if (id !== source.id && !target.enabled)
      throw new AppError(409, "That bot is disabled");
    return target.id;
  }

  private visible(source: Agent, schedule: Schedule) {
    return (
      schedule.agentId === source.id || schedule.createdByAgentId === source.id
    );
  }

  private manageable(source: Agent, id: string) {
    const schedule = this.store.getSchedule(id);
    if (!schedule || !this.visible(source, schedule))
      throw new AppError(404, "Task not found");
    return schedule;
  }

  private when(
    draft: ScheduleDraft,
    cron: string | null,
    runAt: string | null,
  ): Pick<ScheduleInput, "cron" | "runAt"> {
    const nextCron = draft.cron?.trim() ?? "";
    const nextRun = draft.runAt?.trim() ?? "";
    if (nextCron && nextRun)
      throw new AppError(400, "Choose a recurring cron or a one-time date");
    if (nextCron) return { cron: nextCron, runAt: null };
    if (nextRun) return { cron: null, runAt: nextRun };
    const kept = {
      cron: draft.cron !== undefined ? null : cron,
      runAt: draft.runAt !== undefined ? null : runAt,
    };
    if (!kept.cron && !kept.runAt)
      throw new AppError(400, "Choose a recurring cron or a one-time date");
    return kept;
  }

  private present(schedule: Schedule) {
    return {
      id: schedule.id,
      agentId: schedule.agentId,
      agentName: this.store.getAgent(schedule.agentId)?.name ?? "",
      name: schedule.name,
      prompt: schedule.prompt,
      cron: schedule.cron,
      timezone: schedule.timezone,
      runAt: schedule.runAt,
      enabled: schedule.enabled,
      nextRunAt: schedule.nextRunAt,
      createdByAgentId: schedule.createdByAgentId,
    };
  }
}

/** Model tool for the schedule capability. Policy lives in `BotSchedules`. */
export function scheduleExtension(agent: Agent, schedules: BotSchedules) {
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
      if (args.action === "list") return output(schedules.list(agent.id));
      if (!args.id && args.action !== "create")
        throw new AppError(400, "Task ID is required");
      if (args.action === "create")
        return output(schedules.create(agent.id, draft));
      if (args.action === "update")
        return output(schedules.update(agent.id, args.id!, draft));
      if (args.action === "delete")
        return output(schedules.delete(agent.id, args.id!));
      return output(await schedules.run(agent.id, args.id!));
    },
  });
  return defineExtension({
    name: "schedule",
    tools: agent.tools.includes("schedule") ? [schedule] : [],
  });
}
