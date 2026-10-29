import { expect, spyOn, test } from "bun:test";
import { MutationObserver } from "@tanstack/react-query";
import { executionsQuery, queryClient, scriptRunsQuery } from "@/lib/api";
import { runAutomationOptions } from "./automations";

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
