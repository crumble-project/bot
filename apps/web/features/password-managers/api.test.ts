import { expect, test } from "bun:test";
import { refreshCredentials } from "@/features/credentials/api";
import { refreshLogins } from "@/features/logins/api";
import { queryClient } from "@/lib/api";
import { passwordManagersQuery } from "./api";

test.each([
  ["credentials", refreshCredentials],
  ["logins", refreshLogins],
])(
  "refreshing %s refreshes what password managers are used by",
  async (_, refresh) => {
    const { queryKey } = passwordManagersQuery;

    queryClient.setQueryData(queryKey, []);
    await refresh("bot");

    expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    queryClient.clear();
  },
);
