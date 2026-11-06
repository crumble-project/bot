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
import { BotAvatar } from "@/components/bot-avatar";
import prompt from "./generate-avatar-prompt.txt" with { type: "text" };

export function generationPrompt(description: string) {
  return `${prompt}\n\n## User description\n\n${description.trim()}\n`;
}

export function importDefinition(
  json: string,
  current: BotAvatarDefinition,
): BotAvatarDefinition {
  const result = validateAvatar(JSON.parse(json));

  if (!result.ok) throw new Error(result.errors.join("\n"));

  return avatarDefinitionSchema.parse({ ...current, definition: result.value });
}

function ColorInput({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm" htmlFor={id}>
      {label}
      <Input
        id={id}
        value={value}
        maxLength={7}
        className="w-28"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function ColorFields({
  value,
  onChange,
  onError,
}: {
  value: BotAvatarDefinition;
  onChange: (value: BotAvatarDefinition) => void;
  onError: (error: string) => void;
}) {
  const id = useId();
  const [colorEdit, setColorEdit] = useState<string>();
  const [eyeEdit, setEyeEdit] = useState<string>();
  const colorDraft = colorEdit ?? value.color;
  const eyeDraft = eyeEdit ?? value.eyeColor;

  const colors = (color: string, eyeColor: string) => {
    const parsed = avatarDefinitionSchema.safeParse({
      ...value,
      color,
      eyeColor,
    });

    if (parsed.success) {
      onChange(parsed.data);
      setColorEdit(undefined);
      setEyeEdit(undefined);
      onError("");
    } else onError("Colors must be #rgb or #rrggbb.");
  };

  return (
    <div className="flex flex-wrap gap-3">
      <ColorInput
        id={`${id}-body`}
        label="Body color"
        value={colorDraft}
        onChange={(color) => {
          setColorEdit(color);
          colors(color, eyeDraft);
        }}
      />
      <ColorInput
        id={`${id}-eyes`}
        label="Eye color"
        value={eyeDraft}
        onChange={(color) => {
          setEyeEdit(color);
          colors(colorDraft, color);
        }}
      />
    </div>
  );
}

function GalleryTab({
  value,
  onPick,
}: {
  value: BotAvatarDefinition;
  onPick: (definition: (typeof examples)[number]) => void;
}) {
  return (
    <TabsContent value="gallery">
      <div className="grid max-h-72 grid-cols-3 gap-2 overflow-auto sm:grid-cols-4">
        {examples.map((definition) => (
          <button
            type="button"
            key={definition.id}
            aria-label={`Pick ${definition.name}`}
            aria-pressed={definition.id === value.definition.id}
            className="flex flex-col items-center gap-1 rounded-xl border p-2 text-xs hover:bg-muted aria-pressed:bg-muted"
            onClick={() => onPick(definition)}
          >
            <BotAvatar
              bot={{
                id: definition.id,
                avatar: { ...value, definition },
              }}
              size={48}
            />
            {definition.name}
          </button>
        ))}
      </div>
    </TabsContent>
  );
}

// State sits above TabsContent, which unmounts its children when another tab opens.
function ImportTab({
  value,
  onChange,
  onError,
  onStatus,
}: {
  value: BotAvatarDefinition;
  onChange: (value: BotAvatarDefinition) => void;
  onError: (error: string) => void;
  onStatus: (status: string) => void;
}) {
  const id = useId();
  const [json, setJson] = useState("");

  const importJson = () => {
    try {
      onChange(importDefinition(json, value));
      onError("");
      onStatus("Avatar imported. Save the bot to keep it.");
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "Invalid avatar JSON");
      onStatus("");
    }
  };

  return (
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
  );
}

function GenerateTab({
  onError,
  onStatus,
}: {
  onError: (error: string) => void;
  onStatus: (status: string) => void;
}) {
  const id = useId();
  const [description, setDescription] = useState("");

  const copyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(generationPrompt(description));
      onStatus(
        "Prompt copied. Give it to any bot or model, then paste its JSON into Import.",
      );
      onError("");
    } catch {
      onError(
        "Could not copy the prompt. Check clipboard access and try again.",
      );
    }
  };

  return (
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
        Copy the Open Bot Avatar prompt with your description. Give it to any
        bot or model, then paste its definition JSON into Import. A bot can also
        suggest its own avatar in chat. Nothing is generated or sent from this
        page.
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
  );
}

export function AvatarEditor({
  value,
  onChange,
}: {
  value: BotAvatarDefinition;
  onChange: (value: BotAvatarDefinition) => void;
}) {
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <BotAvatar
          bot={{ id: value.definition.id, avatar: value }}
          size={80}
          live
        />
        <ColorFields value={value} onChange={onChange} onError={setError} />
      </div>
      <Tabs defaultValue="gallery">
        <TabsList>
          <TabsTrigger value="gallery">Gallery</TabsTrigger>
          <TabsTrigger value="import">Import</TabsTrigger>
          <TabsTrigger value="generate">Generate</TabsTrigger>
        </TabsList>
        <GalleryTab
          value={value}
          onPick={(definition) => {
            onChange({ ...value, definition });
            setError("");
            setStatus("");
          }}
        />
        <ImportTab
          value={value}
          onChange={onChange}
          onError={setError}
          onStatus={setStatus}
        />
        <GenerateTab onError={setError} onStatus={setStatus} />
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
