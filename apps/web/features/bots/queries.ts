import { useQueries, useQuery } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { botsQuery } from "./api";
import type { Bot } from "./api";

export const ALL = "all";

export const SHARED = "shared";

export const ownerItems = (sharedLabel: string, bots: Array<Bot>) => [
  { label: sharedLabel, value: SHARED },
  ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
];

export function useBotQueries<D>(
  queryOf: (botId: string) => UseQueryOptions<D, Error, D, Array<string>>,
) {
  const bots = useQuery(botsQuery);

  const queries = useQueries({
    queries: (bots.data ?? []).map((bot) => queryOf(bot.id)),
  });

  const entries = (bots.data ?? []).flatMap((bot, index) => {
    const query = queries[index];

    return query ? [{ bot, query }] : [];
  });

  const refreshing = bots.isFetching || queries.some((q) => q.isFetching);

  return { bots, entries, refreshing };
}
