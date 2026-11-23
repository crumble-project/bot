import type { UsageState } from "@earendil-works/pi-durable";

type Totals = { tokens: number; cost: number };

type Bucket = UsageState["models"];

const sum = (states: ReadonlyArray<UsageState>, bucket: keyof UsageState) => {
  const totals = new Map<string, Totals>();

  for (const state of states) {
    for (const [key, usage] of Object.entries<Bucket[string]>(state[bucket])) {
      const total = totals.get(key) ?? { tokens: 0, cost: 0 };

      total.tokens += usage.totalTokens;
      total.cost += usage.cost.total;
      totals.set(key, total);
    }
  }

  return [...totals].sort(([, a], [, b]) => b.tokens - a.tokens);
};

/** Pi Durable keys a model `provider/modelId`; a model ID may hold a slash of its own, so split at the first. */
const modelOf = (key: string) => {
  const slash = key.indexOf("/");

  return slash < 0
    ? { provider: "", model: key }
    : { provider: key.slice(0, slash), model: key.slice(slash + 1) };
};

/** Tokens and cost of every model and tool across `states`, most tokens first. */
export function usageSummary(states: ReadonlyArray<UsageState>) {
  return {
    models: sum(states, "models").map(([key, totals]) => ({
      ...modelOf(key),
      ...totals,
    })),
    tools: sum(states, "tools").map(([name, totals]) => ({ name, ...totals })),
  };
}
