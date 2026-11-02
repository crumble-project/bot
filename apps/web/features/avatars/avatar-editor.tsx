import { useId, useState } from "react";
import { examples, validateAvatar } from "open-bot-avatar";
import {
  avatarDefinitionSchema,
  type BotAvatarDefinition,
} from "@crumble/server/contract/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { BotAvatar } from "@/features/bots/avatar";
import prompt from "./generate-avatar-prompt.txt" with { type: "text" };

export function generationPrompt(description: string) {
  return `${prompt}\n\n## User description\n\n${description.trim()}\n`;
}

/** Geometry imports use the library validator; colors are separate from the portable definition. */
export function importDefinition(
  json: string,
  current: BotAvatarDefinition,
): BotAvatarDefinition {
  const result = validateAvatar(JSON.parse(json));

  if (!result.ok) throw new Error(result.errors.join("\n"));

  return avatarDefinitionSchema.parse({ ...current, definition: result.value });
}

export function AvatarEditor({
  value,
  onChange,
}: {
  value: BotAvatarDefinition;
  onChange: (value: BotAvatarDefinition) => void;
}) {
  const id = useId();
  const [json, setJson] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [colorDraft, setColorDraft] = useState(value.color);
  const [eyeDraft, setEyeDraft] = useState(value.eyeColor);

  const importJson = () => {
    try {
      onChange(importDefinition(json, value));
      setError("");
      setStatus("Avatar imported. Save the bot to keep it.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid avatar JSON");
      setStatus("");
    }
  };

  const colors = (color: string, eyeColor: string) => {
    const parsed = avatarDefinitionSchema.safeParse({
      ...value,
      color,
      eyeColor,
    });

    if (parsed.success) {
      onChange(parsed.data);
      setError("");
    } else setError("Colors must be #rgb or #rrggbb.");
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(generationPrompt(description));
      setStatus(
        "Prompt copied. Give it to any bot or model, then paste its JSON into Import.",
      );
      setError("");
    } catch {
      setError(
        "Could not copy the prompt. Check clipboard access and try again.",
      );
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <BotAvatar
          bot={{ id: value.definition.id, avatar: "", avatarDefinition: value }}
          size={80}
          live
        />
        <div className="flex flex-wrap gap-3">
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-body`}>
            Body color
            <Input
              id={`${id}-body`}
              value={colorDraft}
              maxLength={7}
              className="w-28"
              onChange={(e) => {
                setColorDraft(e.target.value);
                colors(e.target.value, eyeDraft);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm" htmlFor={`${id}-eyes`}>
            Eye color
            <Input
              id={`${id}-eyes`}
              value={eyeDraft}
              maxLength={7}
              className="w-28"
              onChange={(e) => {
                setEyeDraft(e.target.value);
                colors(colorDraft, e.target.value);
              }}
            />
          </label>
        </div>
      </div>
      <Tabs defaultValue="gallery">
        <TabsList>
          <TabsTrigger value="gallery">Gallery</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
          <TabsTrigger value="generate">Generate</TabsTrigger>
        </TabsList>
        <TabsContent value="gallery">
          <div className="grid max-h-72 grid-cols-3 gap-2 overflow-auto sm:grid-cols-4">
            {examples.map((definition) => (
              <button
                type="button"
                key={definition.id}
                aria-label={`Pick ${definition.name}`}
                aria-pressed={definition.id === value.definition.id}
                className="flex flex-col items-center gap-1 rounded-xl border p-2 text-xs hover:bg-muted aria-pressed:bg-muted"
                onClick={() => {
                  onChange({ ...value, definition });
                  setError("");
                  setStatus("");
                }}
              >
                <BotAvatar
                  bot={{
                    id: definition.id,
                    avatar: "",
                    avatarDefinition: { ...value, definition },
                  }}
                  size={48}
                />
                {definition.name}
              </button>
            ))}
          </div>
        </TabsContent>
        <TabsContent value="import" className="flex flex-col gap-2">
          <label htmlFor={`${id}-json`}>Definition JSON</label>
          <Textarea
            id={`${id}-json`}
            value={json}
            maxLength={16000}
            rows={6}
            placeholder='{"version":1,"id":"…","name":"…","body":{"path":"…"},"eyes":{…}}'
            onChange={(e) => setJson(e.target.value)}
          />
          <Button type="button" variant="outline" onClick={importJson}>
            Validate and import
          </Button>
        </TabsContent>
        <TabsContent value="generate" className="flex flex-col gap-2">
          <label htmlFor={`${id}-description`}>Describe your avatar</label>
          <Textarea
            id={`${id}-description`}
            value={description}
            maxLength={4000}
            placeholder="A gardening companion shaped like a watering can"
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="text-sm text-muted-foreground">
            Copy the Open Bot Avatar prompt with your description. Give it to
            any bot or model, then paste its definition JSON into Import. A bot
            can also suggest its own avatar in chat. Nothing is generated or
            sent from this page.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={!description.trim()}
            onClick={() => void copyPrompt()}
          >
            Copy generation prompt
          </Button>
        </TabsContent>
      </Tabs>
      {error && (
        <p
          role="alert"
          className="whitespace-pre-wrap text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {status && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
    </div>
  );
}
