import cronstrue from "cronstrue";
import { hasBareWeekdayStep } from "../contract/cron";
import type { Schedule } from "../contract/schedules";

function cronText(cron: string) {
  const fields = cron.trim().split(/\s+/);

  const days =
    fields.length === 6 ? [fields[3], fields[5]] : [fields[2], fields[4]];

  if (
    ((fields.length === 5 || fields.length === 6) &&
      days.every((day) => day !== "*" && day !== "?")) ||
    hasBareWeekdayStep(cron)
  )
    return cron;

  try {
    return cronstrue.toString(cron, { use24HourTimeFormat: true });
  } catch {
    return cron;
  }
}

function timingDescription(schedule: Schedule, sourceName?: string) {
  if (schedule.eventSourceId)
    return sourceName ? `On event · ${sourceName}` : "On event";

  if (schedule.cron) return `${cronText(schedule.cron)} (${schedule.timezone})`;

  if (!schedule.runAt) return "Once";

  const date = new Date(schedule.runAt);

  const text = date.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: schedule.timezone,
  });

  return `${date.getTime() < Date.now() && !schedule.nextRunAt ? "Ran" : "Once,"} ${text} (${schedule.timezone})`;
}

export function scheduleDescription(schedule: Schedule, sourceName?: string) {
  const description = timingDescription(schedule, sourceName);

  return {
    ...schedule,
    description,
    timing: `${schedule.enabled ? "" : "Paused · "}${description}`,
  };
}
