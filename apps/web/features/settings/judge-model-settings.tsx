import { useQuery } from "@tanstack/react-query";
import { IconScale } from "@tabler/icons-react";
import {
  RowTile,
  Section,
  SectionError,
  WorkspacePage,
} from "@/components/workspace";
import { type JudgeModel, judgeModelQuery } from "./api";
import { call, queryClient } from "@/lib/api";
import { ModelChoiceRow } from "./model-choice";

/** What judges now, as the row says it: the classifier, the chat fallback, or nothing. */
function effectiveText(data: JudgeModel) {
  const { effective } = data;

  if (!effective)
    return "No model is available, so only commit points such as Pay or Send are held. Add an OpenAI API key for GPT-6 Luna.";

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
      unset={{ value: "default", label: "Default (GPT-6 Luna)" }}
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
    <WorkspacePage title="Judge model">
      <Section
        title="Intent checks"
        description="Before a desktop job clicks, types, or presses a key, this model checks whether the action is irreversible and whether you asked for it. Actions it can't clear wait for your approval in the bot's chat."
      >
        {settings.isError && (
          <SectionError>{settings.error.message}</SectionError>
        )}
        {settings.data && <JudgeModelRow data={settings.data} />}
      </Section>
    </WorkspacePage>
  );
}
