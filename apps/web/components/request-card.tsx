import type { ReactNode, Ref } from "react";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import type { TablerIcon } from "@tabler/icons-react";

export function SettledCard({
  icon: Icon,
  title,
  outcome,
  action,
  ref,
}: {
  icon: TablerIcon;
  title: string;
  outcome: string;
  action?: ReactNode;
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className="flex w-full max-w-sm items-center gap-3 rounded-xl border p-3"
    >
      <Icon className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {title}
      </span>
      <span className="text-xs text-muted-foreground">{outcome}</span>
      {action}
    </div>
  );
}

/**
 * Reads a request's list anew: the cached one can predate a request that just arrived. `reading` is the outcome to show
 * until the list can be trusted, which `conclusive` data can be at once; null after that.
 */
export function useFreshRequest<D>(
  query: UseQueryOptions<D, Error, D, string[]>,
  conclusive: (data: D) => boolean,
) {
  const state = useQuery({ ...query, refetchOnMount: "always" });
  const known = state.data !== undefined && conclusive(state.data);
  const fresh = state.isSuccess && state.isFetchedAfterMount;

  const trusted = known || fresh;

  const readingOf = (query: typeof state) =>
    query.isError ? "Unavailable" : "Loading…";

  const reading = trusted ? null : readingOf(state);

  return { data: state.data, reading };
}
