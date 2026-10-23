import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  type Bot,
  type BotInput,
  api,
  botsQuery,
  modelsQuery,
  providersQuery,
  queryClient,
  send,
} from "./api";

/** Creates a bot, or edits `bot` when given. */
export function BotForm({ bot }: { bot?: Bot }) {
  const navigate = useNavigate();
  const [name, setName] = useState(bot?.name ?? "");
  const [description, setDescription] = useState(bot?.description ?? "");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [provider, setProvider] = useState(bot?.provider ?? "");
  const [model, setModel] = useState(bot?.model ?? "");
  const [enabled, setEnabled] = useState(bot?.enabled ?? true);
  const providers = useQuery(providersQuery);

  const models = useQuery({
    ...modelsQuery(provider),
    enabled: provider !== "",
  });

  const providerItems = (providers.data ?? []).map((each) => ({
    label: each.configured ? each.name : `${each.name} (no key)`,
    value: each.provider,
  }));

  const modelItems = (models.data ?? []).map((each) => ({
    label: each.name,
    value: each.id,
  }));

  // Keep a bot's current model selectable even when the catalog lacks it.
  if (model && !modelItems.some((item) => item.value === model))
    modelItems.unshift({ label: model, value: model });

  const save = useMutation({
    mutationFn: (input: BotInput) =>
      bot
        ? api<Bot>(`/v1/agents/${encodeURIComponent(bot.id)}`, {
            method: "PATCH",
            body: JSON.stringify(input),
          })
        : api<Bot>("/v1/agents", {
            method: "POST",
            body: JSON.stringify(input),
          }),
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
      await navigate({ to: "/bots/$botId", params: { botId: saved.id } });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      send(`/v1/agents/${encodeURIComponent(id)}`, "DELETE"),
    onSuccess: async (_, id) => {
      queryClient.removeQueries({ queryKey: ["chat", id] });
      await queryClient.invalidateQueries({ queryKey: botsQuery.queryKey });
      await navigate({ to: "/" });
    },
  });

  return (
    <div className="flex-1 overflow-y-auto">
      <form
        className="mx-auto w-full max-w-2xl p-6"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({
            name,
            description,
            // An empty new bot gets the server's default instructions.
            instructions: bot || instructions.trim() ? instructions : undefined,
            provider,
            model,
            enabled,
          });
        }}
      >
        <FieldSet>
          <FieldLegend>{bot ? `Edit ${bot.name}` : "New bot"}</FieldLegend>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input
                id="name"
                required
                maxLength={80}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="description">Description</FieldLabel>
              <Input
                id="description"
                maxLength={1000}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="instructions">Instructions</FieldLabel>
              <Textarea
                id="instructions"
                className="min-h-32"
                maxLength={32000}
                placeholder="You are a thoughtful, capable personal assistant."
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>Provider</FieldLabel>
                <Select
                  items={providerItems}
                  value={provider || null}
                  onValueChange={(value) => {
                    setProvider(value ?? "");
                    setModel("");
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose a provider" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {providerItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Model</FieldLabel>
                <Select
                  items={modelItems}
                  value={model || null}
                  onValueChange={(value) => setModel(value ?? "")}
                  disabled={!provider}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue
                      placeholder={
                        models.isFetching ? "Loading…" : "Choose a model"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {modelItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {models.isError && (
                  <FieldError>{models.error.message}</FieldError>
                )}
              </Field>
            </div>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="enabled">Enabled</FieldLabel>
                <FieldDescription>
                  A disabled bot keeps its chat but takes no new work. Disabling
                  stops what it is doing.
                </FieldDescription>
              </FieldContent>
              <Switch
                id="enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </Field>
            {save.isError && <FieldError>{save.error.message}</FieldError>}
            <Field orientation="horizontal" className="justify-between">
              {bot ? (
                <AlertDialog>
                  <AlertDialogTrigger
                    render={<Button type="button" variant="destructive" />}
                  >
                    Delete
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This deletes the bot and its chat. It cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    {remove.isError && (
                      <FieldError>{remove.error.message}</FieldError>
                    )}
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(bot.id)}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              ) : (
                <span />
              )}
              <Button
                type="submit"
                disabled={!name.trim() || !provider || !model || save.isPending}
              >
                {bot ? "Save" : "Create bot"}
              </Button>
            </Field>
          </FieldGroup>
        </FieldSet>
      </form>
    </div>
  );
}
