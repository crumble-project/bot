import cronstrue from "cronstrue";
import { hasBareWeekdayStep } from "@crumble/server/contract/cron";
import type { EventSource } from "@/features/settings/api";
import { relativeTime } from "@/lib/time";
import type { Schedule } from "./api";

export const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

export function describeCron(cron: string, timezone: string) {
  const zone = timezone !== LOCAL_ZONE ? ` (${timezone})` : "";
  const plain = `${cron}${zone}`;
  const fields = cron.trim().split(/\s+/);

  const days =
    fields.length === 6 ? [fields[3], fields[5]] : [fields[2], fields[4]];

  if (
    (fields.length === 5 || fields.length === 6) &&
    days.every((day) => day !== "*" && day !== "?")
  )
    return plain;

  if (hasBareWeekdayStep(cron)) return plain;

  try {
    return `${cronstrue.toString(cron, { use24HourTimeFormat: true })}${zone}`;
  } catch {
    return plain;
  }
}

export function describeTiming(schedule: Schedule, sources?: EventSource[]) {
  if (schedule.eventSourceId) {
    const source = sources?.find((each) => each.id === schedule.eventSourceId);

    return source ? `On event · ${source.name}` : "On event";
  }

  if (schedule.cron) return describeCron(schedule.cron, schedule.timezone);

  if (!schedule.runAt) return "Once";

  const date = new Date(schedule.runAt);

  const text = date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: schedule.timezone,
  });

  return date.getTime() < Date.now() && !schedule.nextRunAt
    ? `Ran ${text}`
    : `Once, ${text}`;
}

/** An automation's timing as the Mac app shows it, prefixed "Paused · " when disabled. */
export function automationTiming(schedule: Schedule, sources?: EventSource[]) {
  return `${schedule.enabled ? "" : "Paused · "}${describeTiming(schedule, sources)}`;
}

/** The wall-clock `YYYY-MM-DDTHH:mm` of `date` in `zone`, for a datetime-local input. */
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

/** The instant whose wall clock in `zone` reads `local`; null when `local` is not a date. */
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

/** A one-off automation that already ran; its result is in the bot's chat. */
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

/** Active automations soonest first, then paused ones, then finished script automations. */
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

/** How soon a run starts, for runs within the next day. */
function soon(date: Date, now: Date) {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);

  if (minutes < 60) return relativeTime.format(Math.max(minutes, 0), "minute");

  return relativeTime.format(Math.round(minutes / 60), "hour");
}

export function nextRunLabel(schedule: Schedule, now: Date) {
  if (!schedule.enabled || !schedule.nextRunAt) return "—";

  const next = new Date(schedule.nextRunAt);

  if (next.getTime() - now.getTime() < 86_400_000) return soon(next, now);

  return next.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "today at 09:00", "Thursday at 09:00", or "Mon, 9 Nov at 09:00", on the clock of `zone`. */
export function humanRun(date: Date, zone: string, now: Date) {
  const day = (value: Date) => Date.parse(wallClock(value, zone).slice(0, 10));
  const days = Math.round((day(date) - day(now)) / 86_400_000);

  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });

  const on =
    days >= 0 && days < 2
      ? relativeTime.format(days, "day")
      : date.toLocaleDateString(
          undefined,
          days > 0 && days < 7
            ? { weekday: "long", timeZone: zone }
            : {
                weekday: "short",
                day: "numeric",
                month: "short",
                timeZone: zone,
              },
        );

  return `${on} at ${time}`;
}
