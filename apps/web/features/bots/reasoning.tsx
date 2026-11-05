import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  type Bot,
  agentPath,
  botsQuery,
  type BotInput,
  refreshBots,
} from "./api";
import { type Model, modelsQuery } from "@/features/providers/api";
import { queryClient, send } from "@/lib/api";
import { THINKING_LEVELS } from "@crumble/server/contract/agents";

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

const LEVELS = THINKING_LEVELS.map((value) => ({
  value,
  label: LEVEL_LABELS[value],
}));

/** The levels `model` takes; a model ID outside the catalog may take any. */
export const levelsOf = (model?: Model): readonly ThinkingLevel[] =>
  model?.thinkingLevels ?? THINKING_LEVELS;

/** The level a turn runs at, the nearest supported one preferring higher, as Pi AI's `clampThinkingLevel`. */
export function clampLevel(
  level: ThinkingLevel,
  levels: readonly ThinkingLevel[],
): ThinkingLevel {
  const supported = new Set(levels);

  if (supported.has(level)) return level;
  const index = THINKING_LEVELS.indexOf(level);

  return (
    THINKING_LEVELS.slice(index + 1).find((each) => supported.has(each)) ??
    THINKING_LEVELS.slice(0, index)
      .toReversed()
      .find((each) => supported.has(each)) ??
    levels[0] ??
    "off"
  );
}

export function ReasoningSelect({
  id,
  levels,
  value,
  onChange,
  compact,
  disabled,
}: {
  id?: string;
  levels: readonly ThinkingLevel[];
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const items = LEVELS.filter((level) => levels.includes(level.value));

  return (
    <Select
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next) onChange(next);
      }}
    >
      <SelectTrigger
        id={id}
        title="Reasoning"
        aria-label="Reasoning"
        className={cn(
          compact
            ? "border-transparent bg-transparent text-muted-foreground hover:text-foreground dark:bg-transparent"
            : "w-full",
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={!compact}>
        <SelectGroup>
          {items.map((level) => (
            <SelectItem key={level.value} value={level.value}>
              {level.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

/** The composer's level picker; it saves to the bot, so the next turn uses it. Hidden for models that don't reason. */
export function BotReasoning({ bot }: { bot: Bot }) {
  const models = useQuery(modelsQuery(bot.provider)).data;
  const levels = levelsOf(models?.find((model) => model.id === bot.model));
  const value = clampLevel(bot.inference?.thinkingLevel ?? "off", levels);

  const save = useMutation({
    mutationFn: (thinkingLevel: ThinkingLevel) =>
      send<"updateAgent">(agentPath(bot.id), "PATCH", {
        inference: { ...bot.inference, thinkingLevel },
      } satisfies Partial<BotInput>),
    onMutate: (thinkingLevel) =>
      queryClient.setQueryData(botsQuery.queryKey, (bots) =>
        bots?.map((each) =>
          each.id === bot.id
            ? { ...each, inference: { ...each.inference, thinkingLevel } }
            : each,
        ),
      ),
    onSettled: () => refreshBots(),
  });

  if (levels.length < 2) return null;

  return (
    <ReasoningSelect
      compact
      levels={levels}
      value={value}
      disabled={save.isPending}
      onChange={(level) => save.mutate(level)}
    />
  );
}
