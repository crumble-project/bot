import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconKey } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { SecretForm } from "@/components/form-fields";
import { RowTile, SettingRow, StatusDot } from "@/components/workspace";
import {
  type PluginSettings,
  pluginSettingPath,
  pluginSettingsQuery,
  queryClient,
  send,
} from "@/lib/api";

type Plugin = PluginSettings["plugins"][number];

type Setting = Plugin["settings"][number];

type Contribution = Plugin["contributes"][number];

function SecretSettingEditor({
  label,
  editing,
  error,
  value,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  label: string;
  editing: boolean;
  error: string | undefined;
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!editing && error === undefined) return null;

  return (
    <div className="flex flex-col gap-2 px-3 pb-3 pl-14">
      {editing && (
        <SecretForm
          label={label}
          value={value}
          pending={pending}
          onChange={onChange}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </div>
  );
}

/** One secret a plugin needs: its status, and adding, replacing, or removing it. */
function SecretSetting({
  pluginId,
  setting,
  onChange,
}: {
  pluginId: string;
  setting: Setting;
  onChange: (() => Promise<void>) | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const path = pluginSettingPath(pluginId, setting.key);
  const { configured } = setting;

  const save = useMutation({
    mutationFn: (next: string | null) =>
      next === null ? send(path, "DELETE") : send(path, "PUT", { value: next }),
    onSuccess: async () => {
      setValue("");
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pluginSettingsQuery.queryKey,
        }),
        onChange?.(),
      ]);
      // Drop the submitted value from the mutation state.
      save.reset();
    },
  });

  return (
    <div className="flex flex-col">
      <SettingRow
        tile={
          <RowTile>
            <IconKey />
          </RowTile>
        }
        title={setting.label}
        description={
          <StatusDot
            on={configured}
            label={configured ? "Saved" : setting.whenMissing}
          />
        }
      >
        {!editing && (
          <Button
            variant={configured ? "ghost" : "outline"}
            size="sm"
            onClick={() => setEditing(true)}
          >
            {configured ? "Replace" : "Add key"}
          </Button>
        )}
        {configured && !editing && (
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Remove
          </Button>
        )}
      </SettingRow>
      <SecretSettingEditor
        label={setting.label}
        editing={editing}
        error={save.isError ? save.error.message : undefined}
        value={value}
        pending={save.isPending}
        onChange={setValue}
        onSave={() => save.mutate(value.trim())}
        onCancel={() => {
          setEditing(false);
          setValue("");
        }}
      />
    </div>
  );
}

/** The settings of every plugin that contributes `contributes`, as the server declares them. */
export function PluginSettingRows({
  contributes,
  onChange,
}: {
  contributes: Contribution;
  /** Runs after a value is saved or removed, for pages whose own status depends on it. */
  onChange?: () => Promise<void>;
}) {
  const settings = useQuery(pluginSettingsQuery);

  if (settings.isError)
    return (
      <div className="p-3">
        <FieldError>{settings.error.message}</FieldError>
      </div>
    );

  return settings.data?.plugins
    .filter((plugin) => plugin.contributes.includes(contributes))
    .flatMap((plugin) =>
      plugin.settings.map((setting) => (
        <SecretSetting
          key={`${plugin.id}/${setting.key}`}
          pluginId={plugin.id}
          setting={setting}
          onChange={onChange}
        />
      )),
    );
}
