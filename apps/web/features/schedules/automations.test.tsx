import { expect, spyOn, test } from "bun:test";
import { MutationObserver } from "@tanstack/react-query";
import { executionsQuery, queryClient, scriptRunsQuery } from "@/lib/api";
import { describeTiming, finished, runAutomationOptions } from "./automations";
import type { Schedule } from "@/lib/api";

test("running an automation invalidates its cached histories", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ admitted: true }),
  );

  const executionsKey = executionsQuery.queryKey;
  const scriptKey = scriptRunsQuery("schedule/1").queryKey;
  const otherKey = scriptRunsQuery("other").queryKey;
  queryClient.setQueryData(executionsKey, []);
  queryClient.setQueryData(scriptKey, []);
  queryClient.setQueryData(otherKey, []);
  let navigated = false;

  try {
    const mutation = new MutationObserver(
      queryClient,
      runAutomationOptions({ id: "schedule/1" }, () => {
        navigated = true;
      }),
    );

    await mutation.mutate();

    expect(navigated).toBe(true);
    expect(queryClient.getQueryState(executionsKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(scriptKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
  } finally {
    fetch.mockRestore();
    queryClient.clear();
  }
});

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
