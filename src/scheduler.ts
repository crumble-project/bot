import { CronExpressionParser } from "cron-parser";
import {
  AppError,
  scheduleInput,
  type Schedule,
  type ScheduleInput,
} from "./domain";
import { Store } from "./store";

export type ScheduleDispatch = (
  agentId: string,
  prompt: string,
  requestId: string,
  scheduleId: string,
) => Promise<unknown>;

/** Persistent schedule coordinator. A resolved dispatch means the work was durably admitted. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private ticking = false;
  private readonly inFlight = new Set<string>();
  private readonly failed = new Map<string, number>();
  private static readonly retryAfterMs = 30_000;
  private currentTick?: Promise<void>;

  constructor(
    private readonly store: Store,
    private readonly dispatch: ScheduleDispatch,
    private readonly intervalMs = 1000,
  ) {}

  create(
    input: ScheduleInput,
    createdByAgentId: string | null = null,
  ): Schedule {
    const value = this.validate(input);
    if (!this.store.getAgent(value.agentId))
      throw new AppError(404, "Agent not found");
    const schedule = this.store.createSchedule(
      value,
      undefined,
      createdByAgentId,
    );
    return this.setInitialNext(schedule);
  }

  update(id: string, input: Partial<ScheduleInput>): Schedule | null {
    const old = this.store.getSchedule(id);
    if (!old) throw new AppError(404, "Schedule not found");
    const value = this.validate({ ...old, ...input });
    if (!this.store.getAgent(value.agentId))
      throw new AppError(404, "Agent not found");
    const updated = this.store.updateSchedule(id, value);
    if (!updated) return null;
    for (const key of this.failed.keys())
      if (key.startsWith(`schedule:${id}:`)) this.failed.delete(key);
    return this.setInitialNext(updated);
  }

  async runNow(id: string): Promise<{ admitted: boolean; result?: unknown }> {
    const schedule = this.store.getSchedule(id);
    if (!schedule) throw new AppError(404, "Schedule not found");
    const agent = this.store.getAgent(schedule.agentId);
    if (!agent) throw new AppError(404, "Agent not found");
    if (!schedule.enabled || !agent.enabled)
      throw new AppError(409, "Schedule or agent is disabled");
    if (this.inFlight.has(id)) return { admitted: false };
    const due = new Date().toISOString();
    const requestId = `schedule:${id}:${due}`;
    this.inFlight.add(id);
    try {
      const result = await this.dispatch(
        schedule.agentId,
        schedule.prompt,
        requestId,
        schedule.id,
      );
      return { admitted: true, result };
    } catch (error) {
      this.logDispatchError(schedule.id, error);
      throw error;
    } finally {
      this.inFlight.delete(id);
    }
  }

  async tick(now = new Date()): Promise<void> {
    if (this.currentTick) return this.currentTick;
    const run = this.tickInternal(now);
    this.currentTick = run;
    try {
      await run;
    } finally {
      if (this.currentTick === run) this.currentTick = undefined;
    }
  }

  private async tickInternal(now: Date): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const schedule of this.store.listSchedules()) {
        if (
          !schedule.enabled ||
          !schedule.nextRunAt ||
          !this.store.getAgent(schedule.agentId)?.enabled
        )
          continue;
        const due = new Date(schedule.nextRunAt);
        if (Number.isNaN(due.valueOf()) || due > now) continue;
        const occurrence = due.toISOString();
        const key = `schedule:${schedule.id}:${occurrence}`;
        const failedAt = this.failed.get(key);
        if (
          (failedAt !== undefined &&
            now.valueOf() - failedAt < Scheduler.retryAfterMs) ||
          this.inFlight.has(schedule.id)
        )
          continue;
        const admitted = await this.dispatchOnce(
          schedule,
          occurrence,
          key,
          now.valueOf(),
        );
        if (!admitted) continue;
        const current = this.store.getSchedule(schedule.id);
        if (!current) continue;
        const next = current.cron
          ? this.nextOccurrence(current.cron, current.timezone, now)
          : null;
        this.store.updateNextRunAt(schedule.id, next);
      }
    } finally {
      this.ticking = false;
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick().catch((error) =>
      console.error("Scheduler tick failed", error),
    );
    this.timer = setInterval(
      () =>
        void this.tick().catch((error) =>
          console.error("Scheduler tick failed", error),
        ),
      this.intervalMs,
    );
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.currentTick;
  }

  private async dispatchOnce(
    schedule: Schedule,
    occurrence: string,
    requestId: string,
    failedAt: number,
  ): Promise<boolean> {
    if (this.inFlight.has(schedule.id)) return false;
    this.inFlight.add(schedule.id);
    try {
      await this.dispatch(
        schedule.agentId,
        schedule.prompt,
        requestId,
        schedule.id,
      );
      return true;
    } catch (error) {
      this.logDispatchError(schedule.id, error);
      this.failed.set(requestId, failedAt);
      return false;
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  private validate(input: ScheduleInput): ScheduleInput {
    let value: ScheduleInput;
    try {
      value = scheduleInput.parse(input);
    } catch (error) {
      throw new AppError(
        400,
        error instanceof Error ? error.message : "Invalid schedule",
      );
    }
    try {
      this.assertTimezone(value.timezone);
      if (value.cron)
        this.nextOccurrence(value.cron, value.timezone, new Date());
    } catch (error) {
      throw new AppError(
        400,
        error instanceof Error ? error.message : "Invalid schedule",
      );
    }
    return value;
  }

  private setInitialNext(schedule: Schedule): Schedule {
    const next = schedule.cron
      ? this.nextOccurrence(schedule.cron, schedule.timezone, new Date())
      : schedule.runAt;
    return this.store.updateNextRunAt(schedule.id, next) ?? schedule;
  }

  private nextOccurrence(cron: string, timezone: string, from: Date): string {
    const parsed = CronExpressionParser.parse(cron, {
      currentDate: from,
      tz: timezone,
    });
    return parsed.next().toDate().toISOString();
  }

  private assertTimezone(timezone: string): void {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    } catch {
      throw new Error(`Invalid timezone: ${timezone}`);
    }
  }

  private logDispatchError(scheduleId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Schedule dispatch failed (${scheduleId}): ${message}`);
  }
}
