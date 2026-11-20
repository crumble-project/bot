import type { UseQueryResult } from "@tanstack/react-query";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { Section, SettingRow } from "@/components/page";
import { formatCost, formatTokens } from "@/features/chat/usage";
import type { Provider, Usage } from "./api";
import { ProviderTile } from "./provider-tile";

type Totals = { tokens: number; cost: number };

const amount = ({ tokens, cost }: Totals) =>
  [formatTokens(tokens), formatCost(cost)].filter(Boolean).join(" · ");

const total = (rows: readonly Totals[]) =>
  rows.reduce(
    (sum, row) => ({
      tokens: sum.tokens + row.tokens,
      cost: sum.cost + row.cost,
    }),
    { tokens: 0, cost: 0 },
  );

function Amount({ totals }: { totals: Totals }) {
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {amount(totals)}
    </span>
  );
}

/** The usage's models by provider, in the order of each provider's first, and so largest, model. */
function byProvider(models: Usage["models"]) {
  const groups = new Map<string, Usage["models"]>();

  for (const row of models)
    groups.set(row.provider, [...(groups.get(row.provider) ?? []), row]);

  return [...groups];
}

function ProviderUsage({
  id,
  provider,
  models,
}: {
  id: string;
  provider: Provider | undefined;
  models: Usage["models"];
}) {
  return (
    <Section
      title={provider?.name ?? id}
      icon={provider && <ProviderTile provider={provider} />}
      action={<Amount totals={total(models)} />}
    >
      {models.map((row) => (
        <SettingRow
          key={row.model}
          title={<span className="truncate">{row.model}</span>}
        >
          <Amount totals={row} />
        </SettingRow>
      ))}
    </Section>
  );
}

function UsageSections({
  usage,
  providers,
}: {
  usage: Usage;
  providers: Provider[];
}) {
  if (!usage.models.length && !usage.tools.length)
    return (
      <Empty className="rounded-xl border">
        <EmptyHeader>
          <EmptyTitle>No usage yet</EmptyTitle>
          <EmptyDescription>
            Usage shows here once a bot calls a model.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  const all = total([...usage.models, ...usage.tools]);

  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="font-heading text-2xl font-semibold tabular-nums">
          {formatCost(all.cost) ?? formatTokens(all.tokens)}
        </p>
        <p className="text-sm text-muted-foreground">
          {formatCost(all.cost) && `${formatTokens(all.tokens)}. `}
          Every bot's chat and jobs, since each started. Providers that bill by
          subscription, such as Claude Code, report no cost.
        </p>
      </div>
      {byProvider(usage.models).map(([id, models]) => (
        <ProviderUsage
          key={id}
          id={id}
          provider={providers.find((item) => item.provider === id)}
          models={models}
        />
      ))}
      {usage.tools.length > 0 && (
        <Section
          title="Tools"
          description="Tools that call a model of their own, such as vision questions and intent checks."
          action={<Amount totals={total(usage.tools)} />}
        >
          {usage.tools.map((row) => (
            <SettingRow
              key={row.name}
              title={<span className="truncate">{row.name}</span>}
            >
              <Amount totals={row} />
            </SettingRow>
          ))}
        </Section>
      )}
    </>
  );
}

/** Tokens and cost of the account's bots, grouped by provider, then by model. */
export function UsageView({
  usage,
  providers,
}: {
  usage: UseQueryResult<Usage>;
  providers: Provider[];
}) {
  if (usage.isPending) return <Skeleton className="h-40 rounded-xl" />;

  if (usage.isError) return <FieldError>{usage.error.message}</FieldError>;

  return <UsageSections usage={usage.data} providers={providers} />;
}
