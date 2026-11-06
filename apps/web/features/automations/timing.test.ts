import { expect, test } from "bun:test";
import type { Schedule } from "./api";
import { describeTiming, finished } from "./timing";

const eventAutomation: Schedule = {
  id: "schedule/2",
  agentId: "bot",
  name: "Triage",
  prompt: "Triage the issue",
  kind: "prompt",
  command: null,
  timeoutSeconds: 600,
  notify: true,
  cron: null,
  timezone: "UTC",
  runAt: null,
  eventSourceId: "source-1",
  enabled: true,
  nextRunAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  createdByAgentId: null,
};

test("an event automation names its source and never counts as finished", () => {
  expect(
    describeTiming(eventAutomation, [
      { id: "source-1", name: "GitHub", createdAt: "", usedBy: 1 },
    ]),
  ).toBe("On event · GitHub");
  expect(describeTiming(eventAutomation)).toBe("On event");
  expect(finished(eventAutomation)).toBe(false);
});
