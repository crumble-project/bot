import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Schedule, ScheduleInput } from "../contract/schedules";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { schedules } from "../bot-store/schema.schedules";

type ScheduleColumns = Omit<
  typeof schedules.$inferInsert,
  "id" | "createdAt" | "createdByAgentId"
>;

const columns = (
  input: ScheduleInput,
  nextRunAt: string | null,
): ScheduleColumns => ({
  agentId: input.agentId,
  name: input.name,
  kind: input.kind,
  prompt: input.prompt,
  command: input.command,
  timeoutSeconds: input.timeoutSeconds,
  notify: input.notify,
  cron: input.cron,
  timezone: input.timezone,
  runAt: input.runAt,
  eventSourceId: input.eventSourceId,
  enabled: input.enabled,
  nextRunAt,
});

/** One-time and recurring automations, each run in one bot's chat. `Scheduler` is the only writer of what one does and when. */
export class ScheduleRepository extends Context.Service<
  ScheduleRepository,
  {
    readonly list: (agentId?: string) => Effect.Effect<Schedule[]>;
    readonly get: (scheduleId: string) => Effect.Effect<Schedule | null>;
    readonly create: (
      input: ScheduleInput,
      nextRunAt: string | null,
      options?: { id?: string; createdByAgentId?: string | null },
    ) => Effect.Effect<Schedule>;
    readonly update: (
      scheduleId: string,
      input: ScheduleInput,
      nextRunAt: string | null,
    ) => Effect.Effect<Schedule | null>;
    readonly delete: (scheduleId: string) => Effect.Effect<boolean>;
    readonly updateNextRunAt: (
      scheduleId: string,
      nextRunAt: string | null,
    ) => Effect.Effect<Schedule | null>;
  }
>()("crumble/automations/ScheduleRepository") {
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

        return rows;
      }, Effect.orDie);

      const get = Effect.fn("ScheduleRepository.get")(function* (
        scheduleId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(schedules)
          .where(eq(schedules.id, scheduleId));

        return row ?? null;
      }, Effect.orDie);

      const create = Effect.fn("ScheduleRepository.create")(function* (
        input: ScheduleInput,
        nextRunAt: string | null,
        options: { id?: string; createdByAgentId?: string | null } = {},
      ) {
        const scheduleId = options.id ?? crypto.randomUUID();

        yield* db.insert(schedules).values({
          id: scheduleId,
          ...columns(input, nextRunAt),
          createdAt: yield* nowIso,
          createdByAgentId: options.createdByAgentId ?? null,
        });

        return (yield* get(scheduleId))!;
      }, Effect.orDie);

      const update = Effect.fn("ScheduleRepository.update")(function* (
        scheduleId: string,
        input: ScheduleInput,
        nextRunAt: string | null,
      ) {
        yield* db
          .update(schedules)
          .set(columns(input, nextRunAt))
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
