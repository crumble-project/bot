import {
  type UseQueryOptions,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import { type Bot, botsQuery } from "@/features/bots/api";

/** The scope that shows every bot. */
export const ALL = "all";

/** The owner of what every bot shares. */
export const SHARED = "shared";

/** The choices of an owner picker: what every bot shares, then each bot. */
export const ownerItems = (sharedLabel: string, bots: Bot[]) => [
  { label: sharedLabel, value: SHARED },
  ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
];

/** Every bot, each with its own query from `queryOf`. */
export function useBotQueries<D>(
  queryOf: (botId: string) => UseQueryOptions<D, Error, D, string[]>,
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
