import type { z } from "zod";
import type { usageDocument } from "@crumble/server/contract/tool-details";

export type UsageDocument = z.infer<typeof usageDocument>;

type Bucket = UsageDocument["models"];

export type UsageRow = {
  kind: "model" | "tool";

  name: string;
  tokens: number;
  cost: number;
};

export function usageRows(
  document: UsageDocument | undefined,
): Array<UsageRow> {
  const rows = (kind: UsageRow["kind"], bucket: Bucket) =>
    Object.entries(bucket ?? {}).map(([name, totals]) => ({
      kind,
      name,
      tokens: totals.totalTokens ?? 0,
      cost: totals.cost?.total ?? 0,
    }));

  return [...rows("model", document?.models), ...rows("tool", document?.tools)];
}

export function formatCost(cost: number) {
  return cost > 0 ? `$${cost.toFixed(4)}` : null;
}

const compact = new Intl.NumberFormat("en", { notation: "compact" });

export const formatTokens = (tokens: number) =>
  `${compact.format(tokens)} ${tokens === 1 ? "token" : "tokens"}`;

export function costLine(document: UsageDocument | undefined) {
  return formatCost(
    usageRows(document).reduce((sum, row) => sum + row.cost, 0),
  );
}
