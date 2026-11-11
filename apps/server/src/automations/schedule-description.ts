import cronstrue from "cronstrue";
import {
  hasBareWeekdayStep,
  nextOccurrence,
  validTimezone,
} from "../contract/cron";
import type { Schedule } from "../contract/schedules";
import type { SchedulePreviewInput } from "../contract/schedule-preview";

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

function timingDescription(
  schedule: Pick<
    Schedule,
    "cron" | "runAt" | "eventSourceId" | "timezone" | "nextRunAt" | "enabled"
  >,
  sourceName?: string,
) {
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

function nextRunLabel(
  schedule: Pick<Schedule, "enabled" | "nextRunAt" | "timezone">,
  now: Date,
) {
  if (!schedule.enabled || !schedule.nextRunAt) return "—";

  const next = new Date(schedule.nextRunAt);
  const minutes = Math.round((next.getTime() - now.getTime()) / 60_000);

  if (next.getTime() - now.getTime() < 86_400_000) {
    const relative = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

    return minutes < 60
      ? relative.format(Math.max(minutes, 0), "minute")
      : relative.format(Math.round(minutes / 60), "hour");
  }

  return next.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: schedule.timezone,
  });
}

export function scheduleDescription<
  T extends Pick<
    Schedule,
    "cron" | "runAt" | "eventSourceId" | "timezone" | "nextRunAt" | "enabled"
  >,
>(schedule: T, sourceName?: string, now = new Date()) {
  const description = timingDescription(schedule, sourceName);

  return {
    ...schedule,
    description,
    nextRunLabel: nextRunLabel(schedule, now),
    timing: `${schedule.enabled ? "" : "Paused · "}${description}`,
  };
}

const previewProblem = (text: string, description = "") => ({
  description,
  text,
  isProblem: true,
  nextRunAt: null,
});

function eventPreview(input: SchedulePreviewInput, sourceName?: string) {
  if (input.eventSourceId === "")
    return previewProblem("Choose an event source.");

  if (!input.eventSourceId) return null;

  if (!sourceName) return previewProblem("Event source not found.");

  const description = `On event · ${sourceName}`;

  return { description, text: description, isProblem: false, nextRunAt: null };
}

function previewRun(
  input: SchedulePreviewInput,
  now: Date,
  description: string,
) {
  if (!validTimezone(input.timezone))
    return { problem: previewProblem("Choose a valid time zone.") };

  if (!input.cron)
    return input.runAt
      ? { run: new Date(input.runAt) }
      : { problem: previewProblem("This schedule never runs.") };

  if (hasBareWeekdayStep(input.cron))
    return {
      problem: previewProblem(
        "Weekday steps need * or a range, like 1-5/2.",
        description,
      ),
    };

  try {
    return { run: nextOccurrence(input.cron, input.timezone, now) };
  } catch {
    return {
      problem: previewProblem("This schedule never runs.", description),
    };
  }
}

function previewRunText(run: Date, now: Date, timezone: string) {
  const day = (date: Date) =>
    Date.parse(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(date),
    );

  const days = Math.round((day(run) - day(now)) / 86_400_000);

  const time = run.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: timezone,
  });

  const on =
    days >= 0 && days < 2
      ? new Intl.RelativeTimeFormat("en-US", { numeric: "auto" }).format(
          days,
          "day",
        )
      : run.toLocaleDateString(
          "en-US",
          days > 0 && days < 7
            ? { weekday: "long", timeZone: timezone }
            : {
                weekday: "short",
                day: "numeric",
                month: "short",
                timeZone: timezone,
              },
        );

  return `${on} at ${time}`;
}

export function previewSchedule(
  input: SchedulePreviewInput,
  sourceName?: string,
  now = new Date(),
) {
  const event = eventPreview(input, sourceName);

  if (event) return event;

  const cronDescription = input.cron
    ? `${cronText(input.cron)} (${input.timezone})`
    : "";

  const result = previewRun(input, now, cronDescription);

  if (result.problem) return result.problem;
  const run = result.run;

  if (input.cron && /(?:^|[,\s])H(?=$|[,(/\s])/.test(input.cron))
    return {
      description: cronDescription,
      text: "Next run available after saving.",
      isProblem: false,
      nextRunAt: null,
    };

  const description = scheduleDescription({
    cron: input.cron ?? null,
    runAt: input.runAt ?? null,
    eventSourceId: null,
    timezone: input.timezone,
    nextRunAt: run.toISOString(),
    enabled: true,
  }).description;

  if (run < now) return previewProblem("This time has passed.", description);

  return {
    description,
    text: `${input.cron ? "Next run" : "Runs"} ${previewRunText(run, now, input.timezone)} (${input.timezone})`,
    isProblem: false,
    nextRunAt: run.toISOString(),
  };
}
