import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import { WorkspacePage } from "@/components/workspace";
import { Button } from "@/components/ui/button";
import { agentPath, botsQuery, queryClient, send } from "@/lib/api";
import { BotAvatar, type BotState } from "@/features/bots/avatar";
import { AvatarEditor } from "./avatar-editor";

/** Try portable definitions and save one to a bot. */
export function AvatarsPage() {
  const { data: bots = [] } = useQuery(botsQuery);
  const [selected, setSelected] = useState("");

  const [value, setValue] = useState(() => defaultAvatarDefinition("crumble"));

  const save = useMutation({
    mutationFn: () => send(agentPath(selected), "PATCH", { avatar: value }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["bots"] }),
  });

  return (
    <WorkspacePage title="Avatars">
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
        {save.isError && (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        )}
        {save.isSuccess && <p role="status">Avatar saved.</p>}
      </div>
    </WorkspacePage>
  );
}
