import type { Schedule } from "./api";

export const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function wallClock(date: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );

  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

export function fromWallClock(local: string, zone: string) {
  const guess = new Date(`${local}:00Z`);

  if (Number.isNaN(guess.getTime())) return null;

  let instant = guess.getTime();

  // Two passes settle the zone offset, also across a daylight-saving change.
  for (let pass = 0; pass < 2; pass++) {
    const shown = new Date(`${wallClock(new Date(instant), zone)}:00Z`);
    instant += guess.getTime() - shown.getTime();
  }

  return new Date(instant);
}

export function inOneHour(zone: string) {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);

  return wallClock(date, zone);
}

export const finished = (schedule: Schedule) =>
  !schedule.cron && !schedule.eventSourceId && !schedule.nextRunAt;

export type Status = "active" | "paused" | "completed";

export const statusOf = (schedule: Schedule): Status => {
  if (finished(schedule)) return "completed";

  return schedule.enabled ? "active" : "paused";
};

const RANK = { active: 0, paused: 1, completed: 2 } satisfies Record<
  Status,
  number
>;

const nextTime = (schedule: Schedule) =>
  schedule.nextRunAt ? Date.parse(schedule.nextRunAt) : Infinity;

export function listed(schedules: Schedule[]) {
  return schedules
    .filter((schedule) => schedule.kind === "script" || !finished(schedule))
    .sort((a, b) => {
      const rank = RANK[statusOf(a)] - RANK[statusOf(b)];

      if (rank) return rank;

      if (nextTime(a) === nextTime(b)) return a.name.localeCompare(b.name);

      return nextTime(a) < nextTime(b) ? -1 : 1;
    });
}
