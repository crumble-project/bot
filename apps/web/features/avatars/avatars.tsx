import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import {
  agentPath,
  botsQuery,
  type BotInput,
  invalidateBots,
} from "@/features/bots/api";
import { send } from "@/lib/api";
import { BotAvatar, type BotState } from "@/components/bot-avatar";
import { AvatarEditor } from "./avatar-editor";

export function AvatarsPage() {
  const { data: bots = [] } = useQuery(botsQuery);
  const [selected, setSelected] = useState("");

  const [value, setValue] = useState(() => defaultAvatarDefinition("crumble"));

  const save = useMutation({
    mutationFn: () =>
      send<"updateAgent">(agentPath(selected), "PATCH", {
        avatar: value,
      } satisfies Partial<BotInput>),
    onSuccess: invalidateBots,
  });

  return (
    <Page title="Avatars">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 sm:p-6">
        <p className="text-sm text-muted-foreground">
          Choose a gallery shape, import a definition, or copy a prompt to
          design your own.
        </p>
        <div className="grid grid-cols-3 gap-4">
          {(["idle", "working", "sleeping"] satisfies BotState[]).map(
            (state) => (
              <div
                key={state}
                className="flex flex-col items-center gap-2 text-sm capitalize"
              >
                <BotAvatar
                  bot={{ id: "preview", avatar: value }}
                  size={96}
                  live
                  state={state}
                />
                {state}
              </div>
            ),
          )}
        </div>
        {/* A pending PATCH can't be cancelled; edits during it could save out of order. */}
        <fieldset disabled={save.isPending} className="flex flex-col gap-6">
          <label className="flex flex-col gap-2 text-sm">
            Bot to edit
            <select
              aria-label="Bot to edit"
              value={selected}
              className="rounded-md border bg-background p-2"
              onChange={(e) => {
                const bot = bots.find((each) => each.id === e.target.value);
                setSelected(e.target.value);

                if (bot) setValue(bot.avatar);
                save.reset();
              }}
            >
              <option value="">Preview only</option>
              {bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>
          <AvatarEditor
            key={selected}
            value={value}
            onChange={(next) => {
              setValue(next);
              save.reset();
            }}
          />
          <Button
            disabled={!selected || save.isPending}
            onClick={() => save.mutate()}
          >
            Save avatar to bot
          </Button>
        </fieldset>
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        )}
        {save.isSuccess && <p role="status">Avatar saved.</p>}
      </div>
    </Page>
  );
}
