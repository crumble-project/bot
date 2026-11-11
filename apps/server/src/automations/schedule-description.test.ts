import { expect, test } from "bun:test";
import type { Schedule } from "../contract/schedules";
import { scheduleDescription } from "./schedule-description";

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
