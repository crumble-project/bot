import { expect, test } from "bun:test";
import type { Schedule } from "./api";
import { finished } from "./timing";

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
  description: "On event · GitHub",
  timing: "On event · GitHub",
  createdAt: "2026-11-01T00:00:00.000Z",
  createdByAgentId: null,
};

test("an event automation never counts as finished", () => {
  expect(finished(eventAutomation)).toBe(false);
});
