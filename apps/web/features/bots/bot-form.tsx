import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { IconCopy } from "@tabler/icons-react";
import { AlertDialog, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { type Bot, type BotInput, agentPath, invalidateBots } from "./api";
import { BotFields, useBotFields } from "./bot-fields";
import { call, queryClient, send } from "@/lib/api";
import { ConfirmDeleteContent, Page } from "@/components/page";
import { chatQuery } from "@/features/chat/api";
import { invalidateSchedules } from "@/features/automations/api";

function useBotMutations(bot: Bot | undefined) {
  const navigate = useNavigate();

  const after = async (saved: { id: string } | null) => {
    await invalidateBots();

    if (saved)
      await navigate({ to: "/bots/$botId", params: { botId: saved.id } });
  };

  const save = useMutation({
    mutationFn: (values: BotInput) =>
      bot
        ? call<"updateAgent">(agentPath(bot.id), "PATCH", {
            ...values,
            desktopModel: values.desktopModel ?? null,
          } satisfies BotInput)
        : call<"createAgent">("/v1/agents", "POST", values),
    onSuccess: after,
  });

  const duplicate = useMutation({
    mutationFn: (id: string) =>
      call<"duplicateAgent">(`${agentPath(id)}/duplicate`, "POST"),
    onSuccess: async (copy) => {
      await invalidateBots();

      if (copy)
        await navigate({ to: "/bots/$botId/edit", params: { botId: copy.id } });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => send<"deleteAgent">(agentPath(id), "DELETE"),
    onSuccess: async (_, id) => {
      queryClient.removeQueries({ queryKey: chatQuery(id).queryKey });
      await invalidateBots();
      await invalidateSchedules();
      await navigate({ to: "/" });
    },
  });

  return { save, duplicate, remove };
}

function BotFormActions({
  bot,
  disabled,
}: {
  bot: Bot | undefined;
  disabled: boolean;
}) {
  const navigate = useNavigate();

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() =>
          void (bot
            ? navigate({ to: "/bots/$botId", params: { botId: bot.id } })
            : navigate({ to: "/" }))
        }
      >
        Cancel
      </Button>
      <Button type="submit" form="bot-form" size="sm" disabled={disabled}>
        {bot ? "Save" : "Create bot"}
      </Button>
    </>
  );
}

function BotManagementActions({
  bot,
  duplicate,
  remove,
}: {
  bot: Bot | undefined;
  duplicate: ReturnType<typeof useBotMutations>["duplicate"];
  remove: ReturnType<typeof useBotMutations>["remove"];
}) {
  return (
    <>
      {duplicate.isError && <FieldError>{duplicate.error.message}</FieldError>}

      <div className="flex flex-wrap items-center gap-2">
        {bot && (
          <>
            <AlertDialog>
              <AlertDialogTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  />
                }
              >
                Delete
              </AlertDialogTrigger>
              <ConfirmDeleteContent
                title={`Delete ${bot.name}?`}
                description="The bot, its chat, memories and automations will be removed. This cannot be undone."
                error={remove.error}
                pending={remove.isPending}
                onConfirm={() => remove.mutate(bot.id)}
              />
            </AlertDialog>
            <Button
              type="button"
              variant="outline"
              disabled={duplicate.isPending}
              onClick={() => duplicate.mutate(bot.id)}
            >
              <IconCopy data-icon="inline-start" />
              Duplicate
            </Button>
          </>
        )}
      </div>
    </>
  );
}

function inputOf(bot: Bot): BotInput {
  return {
    name: bot.name,
    description: bot.description,
    instructions: bot.instructions,
    provider: bot.provider,
    model: bot.model,
    enabled: bot.enabled,
    tools: bot.tools,
    webSearchProvider: bot.webSearchProvider ?? null,
    mcpServers: bot.mcpServers,
    ...(bot.avatar !== undefined && { avatar: bot.avatar }),
    ...(bot.inference !== undefined && {
      inference: bot.inference,
    }),
    ...(bot.desktopModel !== undefined && {
      desktopModel: bot.desktopModel,
    }),
  };
}

export function BotForm({ bot }: { bot?: Bot }) {
  const fields = useBotFields(bot && inputOf(bot), bot?.id);
  const { save, duplicate, remove } = useBotMutations(bot);

  return (
    <Page
      title={bot ? `Edit ${bot.name}` : "New bot"}
      actions={
        <BotFormActions bot={bot} disabled={fields.invalid || save.isPending} />
      }
    >
      <BotFields
        formId="bot-form"
        fields={fields}
        failed={save.isError}
        includeSettingsLinks
        onSubmit={(input) => save.mutate(input)}
      />
      {save.isError && <FieldError>{save.error.message}</FieldError>}
      <BotManagementActions bot={bot} duplicate={duplicate} remove={remove} />
    </Page>
  );
}
