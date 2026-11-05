import { useQuery } from "@tanstack/react-query";
import { IconEye } from "@tabler/icons-react";
import {
  RowTile,
  Section,
  SectionError,
  WorkspacePage,
} from "@/components/workspace";
import { type VisionModel, visionModelQuery } from "./api";
import { call, queryClient } from "@/lib/api";
import { ModelChoiceRow, modelKey } from "./model-choice";

function statusText({ visionModel, choices }: VisionModel) {
  if (!visionModel)
    return "Off. A bot whose model can't read images refuses them in its chat and gets only their names in group chats.";

  const chosen = choices.find(
    (item) => modelKey(item) === modelKey(visionModel),
  );

  if (!chosen)
    return `No provider key reaches ${visionModel.model}, so images can't be read. Choose another model or turn it off.`;

  return `${chosen.name} describes images for bots whose model can't read them.`;
}

function VisionModelRow({ data }: { data: VisionModel }) {
  return (
    <ModelChoiceRow
      title="Vision model"
      tile={
        <RowTile>
          <IconEye />
        </RowTile>
      }
      unset={{ value: "off", label: "Off" }}
      chosen={data.visionModel}
      choices={data.choices}
      description={statusText(data)}
      save={async (visionModel) => {
        const next = await call<"updateVisionModel">(
          "/v1/vision-model",
          "PUT",
          { visionModel },
        );

        queryClient.setQueryData(visionModelQuery.queryKey, next);
      }}
    />
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
          <SectionError>{settings.error.message}</SectionError>
        )}
        {settings.data && <VisionModelRow data={settings.data} />}
      </Section>
    </WorkspacePage>
  );
}
