import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import {
  mergeScheduleInput,
  scheduleInput,
  type Schedule,
  type ScheduleInput,
} from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { schedules } from "./schema";

const scheduleOf = (row: typeof schedules.$inferSelect): Schedule => ({
  id: row.id,
  agentId: row.agentId,
  name: row.name,
  kind: row.kind,
  prompt: row.prompt,
  command: row.command,
  timeoutSeconds: row.timeoutSeconds,
  notify: row.notify,
  cron: row.cron,
  timezone: row.timezone,
  runAt: row.runAt,
  enabled: row.enabled,
  nextRunAt: row.nextRunAt,
  createdAt: row.createdAt,
  createdByAgentId: row.createdByAgentId ?? null,
});

/** One-time and recurring tasks, each run in one bot's chat. */
export class ScheduleRepository extends Context.Service<
  ScheduleRepository,
  {
    readonly list: (agentId?: string) => Effect.Effect<Schedule[]>;
    readonly get: (scheduleId: string) => Effect.Effect<Schedule | null>;
    readonly create: (
      input: ScheduleInput,
      scheduleId?: string,
      createdByAgentId?: string | null,
    ) => Effect.Effect<Schedule>;
    readonly update: (
      scheduleId: string,
      patch: Partial<ScheduleInput>,
    ) => Effect.Effect<Schedule | null>;
    readonly delete: (scheduleId: string) => Effect.Effect<boolean>;
    readonly updateNextRunAt: (
      scheduleId: string,
      nextRunAt: string | null,
    ) => Effect.Effect<Schedule | null>;
  }
>()("crumble/schedules/ScheduleRepository") {
  static readonly layer = Layer.effect(
    ScheduleRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const list = Effect.fn("ScheduleRepository.list")(function* (
        agentId: string | undefined,
      ) {
        const rows = yield* db
          .select()
          .from(schedules)
          .where(agentId ? eq(schedules.agentId, agentId) : undefined)
          .orderBy(asc(schedules.createdAt));

        return rows.map(scheduleOf);
      }, Effect.orDie);

      const get = Effect.fn("ScheduleRepository.get")(function* (
        scheduleId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(schedules)
          .where(eq(schedules.id, scheduleId));

        return row ? scheduleOf(row) : null;
      }, Effect.orDie);

      const create = Effect.fn("ScheduleRepository.create")(function* (
        input: ScheduleInput,
        scheduleId: string = crypto.randomUUID(),
        createdByAgentId: string | null = null,
      ) {
        yield* db.insert(schedules).values({
          id: scheduleId,
          agentId: input.agentId,
          name: input.name,
          kind: input.kind,
          prompt: input.kind === "script" ? "" : input.prompt,
          command: input.command,
          timeoutSeconds: input.timeoutSeconds,
          notify: input.notify,
          cron: input.cron,
          timezone: input.timezone,
          runAt: input.runAt,
          enabled: input.enabled,
          nextRunAt: input.runAt,
          createdAt: yield* nowIso,
          createdByAgentId,
        });

        return (yield* get(scheduleId))!;
      }, Effect.orDie);

      const update = Effect.fn("ScheduleRepository.update")(function* (
        scheduleId: string,
        patch: Partial<ScheduleInput>,
      ) {
        const schedule = yield* get(scheduleId);

        if (!schedule) return null;
        const next = scheduleInput.parse(mergeScheduleInput(schedule, patch));

        yield* db
          .update(schedules)
          .set({
            agentId: next.agentId,
            name: next.name,
            kind: next.kind,
            prompt: next.kind === "script" ? "" : next.prompt,
            command: next.command,
            timeoutSeconds: next.timeoutSeconds,
            notify: next.notify,
            cron: next.cron,
            timezone: next.timezone,
            runAt: next.runAt,
            enabled: next.enabled,
            nextRunAt: next.runAt,
          })
          .where(eq(schedules.id, scheduleId));

        return yield* get(scheduleId);
      }, Effect.orDie);

      const remove = Effect.fn("ScheduleRepository.delete")(function* (
        scheduleId: string,
      ) {
        const deleted = yield* db
          .delete(schedules)
          .where(eq(schedules.id, scheduleId))
          .returning({ id: schedules.id });

        return deleted.length > 0;
      }, Effect.orDie);

      const updateNextRunAt = Effect.fn("ScheduleRepository.updateNextRunAt")(
        function* (scheduleId: string, nextRunAt: string | null) {
          if (!(yield* get(scheduleId))) return null;

          yield* db
            .update(schedules)
            .set({ nextRunAt })
            .where(eq(schedules.id, scheduleId));

          return yield* get(scheduleId);
        },
        Effect.orDie,
      );

      return ScheduleRepository.of({
        list: (agentId) => list(agentId),
        get,
        create,
        update,
        delete: remove,
        updateNextRunAt,
      });
    }),
  );
}
