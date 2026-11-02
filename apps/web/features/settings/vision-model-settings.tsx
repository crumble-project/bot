import { useMutation, useQuery } from "@tanstack/react-query";
import { IconEye } from "@tabler/icons-react";
import { FieldError } from "@/components/ui/field";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SelectOptions } from "@/components/form-fields";
import {
  RowTile,
  Section,
  SettingRow,
  WorkspacePage,
} from "@/components/workspace";
import {
  type VisionModel,
  call,
  queryClient,
  visionModelQuery,
} from "@/lib/api";

const OFF = "off";

const keyOf = (ref: { provider: string; model: string }) =>
  `${ref.provider}/${ref.model}`;

/** The chosen model's key is gone when no choice matches it. */
const unreachable = (data: VisionModel) =>
  data.visionModel !== null &&
  !data.choices.some((item) => keyOf(item) === keyOf(data.visionModel!));

function statusText(data: VisionModel) {
  if (!data.visionModel)
    return "Off. A bot whose model can't read images refuses them in its chat and gets only their names in group chats.";

  if (unreachable(data))
    return `No provider key reaches ${data.visionModel.model}, so images can't be read. Choose another model or turn it off.`;

  const name =
    data.choices.find((item) => keyOf(item) === keyOf(data.visionModel!))
      ?.name ?? data.visionModel.model;

  return `${name} describes images for bots whose model can't read them.`;
}

/** The choices: off, each reachable model that reads images, and a chosen one whose key is gone, so the owner sees why. */
function visionItems(data: VisionModel) {
  const chosen = data.visionModel;

  const gone =
    chosen && unreachable(data)
      ? [{ value: keyOf(chosen), label: `${chosen.model} (no key)` }]
      : [];

  return [
    { value: OFF, label: "Off" },
    ...data.choices.map((item) => ({ value: keyOf(item), label: item.name })),
    ...gone,
  ];
}

function VisionModelRow({ data }: { data: VisionModel }) {
  const items = visionItems(data);

  const change = useMutation({
    mutationFn: (value: string) => {
      const choice = data.choices.find((item) => keyOf(item) === value);

      return call<
        VisionModel,
        { visionModel: { provider: string; model: string } | null }
      >("/v1/vision-model", "PUT", {
        visionModel: choice
          ? { provider: choice.provider, model: choice.model }
          : null,
      });
    },
    onSuccess: (next) =>
      queryClient.setQueryData(visionModelQuery.queryKey, next),
  });

  return (
    <SettingRow
      tile={
        <RowTile>
          <IconEye />
        </RowTile>
      }
      title="Vision model"
      description={change.error?.message ?? statusText(data)}
    >
      <Select
        items={items}
        value={data.visionModel ? keyOf(data.visionModel) : OFF}
        onValueChange={(next) => change.mutate(next ?? OFF)}
      >
        <SelectTrigger aria-label="Vision model" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectOptions items={items} />
      </Select>
    </SettingRow>
  );
}

export function VisionModelPage() {
  const settings = useQuery(visionModelQuery);

  return (
    <WorkspacePage title="Vision model">
      <Section
        title="Images for text-only models"
        description="When a bot's model can't read images, this model describes each image it gets, including any visible text, and the bot works from the description. The bot can also ask it questions about an image. Its tokens count toward the conversation's usage."
      >
        {settings.isError && (
          <div className="p-3">
            <FieldError>{settings.error.message}</FieldError>
          </div>
        )}
        {settings.data && <VisionModelRow data={settings.data} />}
      </Section>
    </WorkspacePage>
  );
}
