import { expect, spyOn, test } from "bun:test";
import { QueryObserver } from "@tanstack/react-query";
import { invalidateCredentials } from "@/features/credentials/api";
import { invalidateLogins } from "@/features/logins/api";
import { queryClient } from "@/lib/api";
import { passwordManagersQuery } from "./api";

test.each([
  ["credentials", invalidateCredentials],
  ["logins", invalidateLogins],
])(
  "refreshing %s refreshes what password managers are used by",
  async (_, refresh) => {
    const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ passwordManagers: [] }),
    );

    queryClient.setQueryData(passwordManagersQuery.queryKey, []);

    const stopObserving = new QueryObserver(
      queryClient,
      passwordManagersQuery,
    ).subscribe(() => {});

    try {
      await refresh("bot");

      expect(fetch.mock.calls.map(([path]) => path)).toEqual([
        "/v1/password-managers",
      ]);
    } finally {
      stopObserving();
      fetch.mockRestore();
      queryClient.clear();
    }
  },
);
