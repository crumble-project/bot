import { useQuery } from "@tanstack/react-query";
import { usageDocument } from "@crumble/server/contract/tool-details";
import { chatQuery } from "@/features/chat/api";
import {
  type UsageRow,
  costLine,
  formatCost,
  formatTokens,
  usageRows,
} from "@/features/chat/usage";

/** `provider/modelId` shows as the model ID; the provider is the bot's or obvious from it. */
const label = (row: UsageRow) =>
  row.kind === "model" ? row.name.slice(row.name.indexOf("/") + 1) : row.name;

function Row({ row }: { row: UsageRow }) {
  const cost = formatCost(row.cost);

  return (
    <li className="flex items-baseline gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate" title={row.name}>
        {label(row)}
        {row.kind === "tool" && (
          <span className="text-muted-foreground"> (tool)</span>
        )}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {[formatTokens(row.tokens), cost].filter(Boolean).join(" · ")}
      </span>
    </li>
  );
}

/** Tokens and cost of the bot chat's own models and tools, from the live snapshot. */
export function ChatUsage({ botId }: { botId: string }) {
  const snapshot = useQuery(chatQuery(botId)).data;
  const usage = usageDocument.safeParse(snapshot?.usage).data;
  const rows = usageRows(usage);
  const total = costLine(usage);

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">Usage</h2>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No usage yet</p>
      ) : (
        <>
          <ul className="flex flex-col gap-1.5">
            {rows.map((row) => (
              <Row key={`${row.kind}:${row.name}`} row={row} />
            ))}
          </ul>
          {total !== null && (
            <p className="text-xs text-muted-foreground">
              Total {total}. Jobs have their own usage.
            </p>
          )}
        </>
      )}
    </section>
  );
}
