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
  type Model,
  agentPath,
  botsQuery,
  call,
  modelsQuery,
  queryClient,
} from "@/lib/api";

export const THINKING_LEVELS = [
  { label: "Off", value: "off" },
  { label: "Minimal", value: "minimal" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
  { label: "Extra high", value: "xhigh" },
  { label: "Maximum", value: "max" },
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number]["value"];

const ORDER = THINKING_LEVELS.map((level) => level.value);

/** The levels `model` takes; a model ID outside the catalog may take any. */
export const levelsOf = (model?: Model): readonly ThinkingLevel[] =>
  model?.thinkingLevels ?? ORDER;

/** The level a turn runs at, the nearest supported one preferring higher, as Pi AI's `clampThinkingLevel`. */
export function clampLevel(
  level: ThinkingLevel,
  levels: readonly ThinkingLevel[],
): ThinkingLevel {
  if (levels.includes(level)) return level;
  const index = ORDER.indexOf(level);

  return (
    ORDER.slice(index + 1).find((each) => levels.includes(each)) ??
    ORDER.slice(0, index)
      .reverse()
      .find((each) => levels.includes(each)) ??
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
  const items = THINKING_LEVELS.filter((level) => levels.includes(level.value));

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
      call<Bot, Pick<Bot, "inference">>(agentPath(bot.id), "PATCH", {
        inference: { ...bot.inference, thinkingLevel },
      }),
    onMutate: (thinkingLevel) =>
      queryClient.setQueryData(botsQuery.queryKey, (bots) =>
        bots?.map((each) =>
          each.id === bot.id
            ? { ...each, inference: { ...each.inference, thinkingLevel } }
            : each,
        ),
      ),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
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
