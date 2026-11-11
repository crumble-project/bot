import { expect, test } from "bun:test";
import type { Schedule } from "../contract/schedules";
import { previewSchedule, scheduleDescription } from "./schedule-description";

const schedule: Schedule = {
  id: "schedule",
  agentId: "bot",
  name: "Task",
  prompt: "Run",
  kind: "prompt",
  command: null,
  timeoutSeconds: 600,
  notify: true,
  cron: "0 9 * * *",
  timezone: "Europe/Berlin",
  runAt: null,
  eventSourceId: null,
  enabled: true,
  nextRunAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  createdByAgentId: null,
};

test("describes cron with a timezone and preserves expressions that cannot be represented accurately", () => {
  expect(scheduleDescription(schedule).description).toBe(
    "At 09:00 (Europe/Berlin)",
  );
  expect(
    scheduleDescription({ ...schedule, cron: "0 9 1 * 1" }).description,
  ).toBe("0 9 1 * 1 (Europe/Berlin)");
  expect(
    scheduleDescription({ ...schedule, cron: "0 9 * * 1/2" }).description,
  ).toBe("0 9 * * 1/2 (Europe/Berlin)");
});

test("describes event sources and paused schedules", () => {
  const event = {
    ...schedule,
    cron: null,
    eventSourceId: "source",
    enabled: false,
  };

  expect(scheduleDescription(event, "GitHub")).toMatchObject({
    description: "On event · GitHub",
    timing: "Paused · On event · GitHub",
  });
  expect(scheduleDescription(event).description).toBe("On event");
});

test("describes one-time schedules in their configured timezone", () => {
  const once = {
    ...schedule,
    cron: null,
    timezone: "UTC",
    runAt: "2000-01-01T12:00:00.000Z",
  };

  expect(scheduleDescription(once).description).toBe(
    "Ran Jan 1, 2000 at 12:00 PM (UTC)",
  );
  expect(
    scheduleDescription({ ...once, runAt: "2099-01-01T12:00:00.000Z" })
      .description,
  ).toBe("Once, Jan 1, 2099 at 12:00 PM (UTC)");
});

test("previews valid and invalid schedules with the scheduler's cron rules", () => {
  const now = new Date("2026-03-28T12:00:00Z");
  expect(
    previewSchedule(
      { cron: "0 9 * * *", timezone: "Europe/Berlin" },
      undefined,
      now,
    ),
  ).toMatchObject({
    description: "At 09:00 (Europe/Berlin)",
    nextRunAt: "2026-03-29T07:00:00.000Z",
    isProblem: false,
  });
  expect(
    previewSchedule({ cron: "H 9 * * *", timezone: "UTC" }, undefined, now),
  ).toMatchObject({
    isProblem: false,
    nextRunAt: null,
    text: "Next run available after saving.",
  });
  expect(
    previewSchedule({ cron: "0 9 * * 1/2", timezone: "UTC" }, undefined, now),
  ).toMatchObject({ isProblem: true, nextRunAt: null });
  expect(
    previewSchedule({ cron: "not cron", timezone: "UTC" }, undefined, now),
  ).toMatchObject({ isProblem: true, nextRunAt: null });
  expect(
    previewSchedule({ cron: "0 9 * * *", timezone: "invalid" }, undefined, now),
  ).toMatchObject({ isProblem: true, nextRunAt: null });
  expect(
    previewSchedule(
      { runAt: "2020-01-01T00:00:00Z", timezone: "UTC" },
      undefined,
      now,
    ),
  ).toMatchObject({ text: "This time has passed.", isProblem: true });
  expect(
    previewSchedule(
      { eventSourceId: "source", timezone: "UTC" },
      "GitHub",
      now,
    ),
  ).toMatchObject({ text: "On event · GitHub", isProblem: false });
});

test("formats the saved next run in the schedule's timezone", () => {
  const now = new Date("2026-01-01T12:00:00Z");
  expect(
    scheduleDescription(
      { ...schedule, nextRunAt: "2026-01-01T12:30:00Z" },
      undefined,
      now,
    ).nextRunLabel,
  ).toBe("in 30 minutes");
  expect(
    scheduleDescription(
      { ...schedule, nextRunAt: "2026-01-01T11:00:00Z" },
      undefined,
      now,
    ).nextRunLabel,
  ).toBe("this minute");
  expect(
    scheduleDescription(
      { ...schedule, nextRunAt: "2026-01-03T12:00:00Z" },
      undefined,
      now,
    ).nextRunLabel,
  ).toBe("Sat, Jan 3 at 01:00 PM");
  expect(
    scheduleDescription(
      { ...schedule, enabled: false, nextRunAt: "2026-01-01T12:30:00Z" },
      undefined,
      now,
    ).nextRunLabel,
  ).toBe("—");
  expect(scheduleDescription(schedule, undefined, now).nextRunLabel).toBe("—");
});

test("previews named weekdays without treating Thursday as a hash", () => {
  expect(
    previewSchedule(
      { cron: "0 9 * * THU", timezone: "UTC" },
      undefined,
      new Date("2026-11-11T00:00:00Z"),
    ),
  ).toMatchObject({ isProblem: false, nextRunAt: "2026-11-12T09:00:00.000Z" });
});
