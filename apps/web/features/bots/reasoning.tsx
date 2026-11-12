import { useEffect, useState } from "react";
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
  invalidateBots,
} from "./api";
import { call, queryClient, send, type ResponseBody } from "@/lib/api";

export type ThinkingLevel = ResponseBody<"previewReasoning">["effectiveLevel"];

type ReasoningOption = ResponseBody<"previewReasoning">["options"][number];

export function matchingReasoningPreview(
  provider?: string,
  model?: string,
  previous?: ResponseBody<"previewReasoning">,
  query?: { queryKey: readonly unknown[] },
) {
  return query !== undefined &&
    query.queryKey[1] === provider &&
    query.queryKey[2] === model
    ? previous
    : undefined;
}

export function reasoningQuery(
  provider: string,
  model: string,
  thinkingLevel: ThinkingLevel,
) {
  return {
    queryKey: ["reasoning-preview", provider, model, thinkingLevel] as const,
    placeholderData: (
      previous: ResponseBody<"previewReasoning"> | undefined,
      query: { queryKey: readonly unknown[] } | undefined,
    ) => matchingReasoningPreview(provider, model, previous, query),
    queryFn: () =>
      call<"previewReasoning">("/v1/reasoning/preview", "POST", {
        provider,
        model,
        thinkingLevel,
      }),
  };
}

export function useReasoningPreview(
  provider: string,
  model: string,
  thinkingLevel: ThinkingLevel,
) {
  const [debouncedModel, setDebouncedModel] = useState(() => model.trim());

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedModel(model.trim()), 250);

    return () => clearTimeout(timer);
  }, [model]);

  const preview = useQuery({
    ...reasoningQuery(provider, debouncedModel, thinkingLevel),
    enabled: debouncedModel === model.trim(),
  });

  const current = debouncedModel === model.trim() ? preview.data : undefined;

  return {
    options: current?.options ?? [],
    level: preview.isPlaceholderData
      ? thinkingLevel
      : (current?.effectiveLevel ?? thinkingLevel),
    previewReady: Boolean(current) && !preview.isPlaceholderData,
    previewError: debouncedModel === model.trim() && preview.isError,
    retryPreview: () => {
      void preview.refetch();
    },
  };
}

export function ReasoningSelect({
  id,
  options,
  value,
  onChange,
  compact,
  disabled,
}: {
  id?: string;
  options: ReasoningOption[];
  value: ThinkingLevel;
  onChange: (level: ThinkingLevel) => void;
  compact?: boolean;
  disabled?: boolean;
}) {
  const items = options;

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

export function BotReasoning({ bot }: { bot: Bot }) {
  const preview = useQuery(
    reasoningQuery(
      bot.provider,
      bot.model,
      bot.inference?.thinkingLevel ?? "off",
    ),
  );

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
    onSettled: () => invalidateBots(),
  });

  if (!preview.data || preview.data.options.length < 2) return null;

  return (
    <ReasoningSelect
      compact
      options={preview.data.options}
      value={
        preview.isPlaceholderData
          ? (bot.inference?.thinkingLevel ?? "off")
          : preview.data.effectiveLevel
      }
      disabled={save.isPending}
      onChange={(level) => save.mutate(level)}
    />
  );
}
