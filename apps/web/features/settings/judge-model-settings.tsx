import { useMutation, useQuery } from "@tanstack/react-query";
import { IconScale } from "@tabler/icons-react";
import { FieldError } from "@/components/ui/field";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SelectOptions } from "@/components/form-fields";
import {
  RowTile,
  Section,
  SettingRow,
  WorkspacePage,
} from "@/components/workspace";
import { type JudgeModel, call, judgeModelQuery, queryClient } from "@/lib/api";

const DEFAULT = "default";

const keyOf = (ref: { provider: string; model: string }) =>
  `${ref.provider}/${ref.model}`;

/** What judges now, as the row says it: the classifier, the chat fallback, or nothing. */
function effectiveText(data: JudgeModel) {
  const { effective } = data;

  if (!effective)
    return "No model is available, so only commit points such as Pay or Send are held. Add an OpenAI API key for GPT-6 Luna.";

  return effective.kind === "chat"
    ? `${effective.name} judges as a chat model: no provider key reaches a classifier.`
    : `${effective.name} judges now.`;
}

/** The choices: the default, each reachable classifier, and a chosen one whose key is gone, so the owner sees why. */
function judgeItems(data: JudgeModel) {
  const chosen = data.judgeModel;

  const gone =
    chosen && !data.choices.some((item) => keyOf(item) === keyOf(chosen))
      ? [{ value: keyOf(chosen), label: `${chosen.model} (no key)` }]
      : [];

  return [
    { value: DEFAULT, label: "Default (GPT-6 Luna)" },
    ...data.choices.map((item) => ({ value: keyOf(item), label: item.name })),
    ...gone,
  ];
}

function JudgeModelRow({ data }: { data: JudgeModel }) {
  const items = judgeItems(data);

  const change = useMutation({
    mutationFn: (value: string) => {
      const choice = data.choices.find((item) => keyOf(item) === value);

      return call<
        JudgeModel,
        { judgeModel: { provider: string; model: string } | null }
      >("/v1/judge-model", "PUT", {
        judgeModel: choice
          ? { provider: choice.provider, model: choice.model }
          : null,
      });
    },
    onSuccess: (next) =>
      queryClient.setQueryData(judgeModelQuery.queryKey, next),
  });

  return (
    <SettingRow
      tile={
        <RowTile>
          <IconScale />
        </RowTile>
      }
      title="Judge model"
      description={change.error?.message ?? effectiveText(data)}
    >
      <Select
        items={items}
        value={data.judgeModel ? keyOf(data.judgeModel) : DEFAULT}
        onValueChange={(next) => change.mutate(next ?? DEFAULT)}
      >
        <SelectTrigger aria-label="Judge model" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectOptions items={items} />
      </Select>
    </SettingRow>
  );
}

export function JudgeModelPage() {
  const settings = useQuery(judgeModelQuery);

  return (
    <WorkspacePage title="Judge model">
      <Section
        title="Intent checks"
        description="Before a desktop job clicks, types, or presses a key, this model checks whether the action is irreversible and whether you asked for it. Actions it can't clear wait for your approval in the bot's chat."
      >
        {settings.isError && (
          <div className="p-3">
            <FieldError>{settings.error.message}</FieldError>
          </div>
        )}
        {settings.data && <JudgeModelRow data={settings.data} />}
      </Section>
    </WorkspacePage>
  );
}
