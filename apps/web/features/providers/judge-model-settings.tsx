import { useQuery } from "@tanstack/react-query";
import { IconScale } from "@tabler/icons-react";
import { RowTile, Section, SectionError, Page } from "@/components/page";
import { type JudgeModel, judgeModelQuery } from "./api";
import { call, queryClient } from "@/lib/api";
import { ModelChoiceRow } from "./model-choice";
import { DEFAULT_JUDGE_MODEL_NAME } from "@crumble/server/contract/tools";

function effectiveText(data: JudgeModel) {
  const { effective } = data;

  if (!effective)
    return `No model is available, so only commit points such as Pay or Send are held. Add an OpenAI API key for ${DEFAULT_JUDGE_MODEL_NAME}.`;

  return effective.kind === "chat"
    ? `${effective.name} judges as a chat model: no provider key reaches a classifier.`
    : `${effective.name} judges now.`;
}

function JudgeModelRow({ data }: { data: JudgeModel }) {
  return (
    <ModelChoiceRow
      title="Judge model"
      tile={
        <RowTile>
          <IconScale />
        </RowTile>
      }
      unset={{
        value: "default",
        label: `Default (${DEFAULT_JUDGE_MODEL_NAME})`,
      }}
      chosen={data.judgeModel}
      choices={data.choices}
      description={effectiveText(data)}
      save={async (judgeModel) => {
        const next = await call<"updateJudgeModel">("/v1/judge-model", "PUT", {
          judgeModel,
        });

        queryClient.setQueryData(judgeModelQuery.queryKey, next);
      }}
    />
  );
}

export function JudgeModelPage() {
  const settings = useQuery(judgeModelQuery);

  return (
    <Page title="Judge model">
      <Section
        title="Intent checks"
        description="Before a desktop job clicks, types, or presses a key, this model checks whether the action is irreversible and whether you asked for it. Actions it can't clear wait for your approval in the bot's chat."
      >
        {settings.isError && (
          <SectionError>{settings.error.message}</SectionError>
        )}
        {settings.data && <JudgeModelRow data={settings.data} />}
      </Section>
    </Page>
  );
}
