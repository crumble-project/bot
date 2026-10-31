import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconKey, IconPencil, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { EditorSheet } from "@/components/form-fields";
import {
  SecretSourceField,
  referenceOf,
  sourceDraftOf,
  useConnectedPasswordManagers,
} from "@/components/secret-source-field";
import { RowMenu, RowTile, SettingRow } from "@/components/workspace";
import {
  type PluginSettings,
  passwordManagersQuery,
  pluginSettingPath,
  pluginSettingsQuery,
  queryClient,
  send,
} from "@/lib/api";

type Plugin = PluginSettings["plugins"][number];

type Setting = Plugin["settings"][number];

type Contribution = Plugin["contributes"][number];

type SettingInput =
  | { value: string }
  | { reference: NonNullable<ReturnType<typeof referenceOf>> }
  | null;

function SecretSettingSheet({
  setting,
  error,
  pending,
  onSave,
  onClose,
}: {
  setting: Setting;
  error: string | undefined;
  pending: boolean;
  onSave: (input: NonNullable<SettingInput>) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState(() =>
    sourceDraftOf(setting.passwordManager, setting.reference),
  );

  const connected = useConnectedPasswordManagers();
  const reference = referenceOf(source);
  const value = source.kind === "value" ? source.value.trim() : "";

  return (
    <EditorSheet
      title={setting.label}
      error={error}
      submitLabel="Save"
      submitDisabled={pending || (!reference && !value)}
      onSubmit={() => onSave(reference ? { reference } : { value })}
      onClose={onClose}
    >
      <SecretSourceField
        id={`plugin-setting-${setting.key}`}
        label="Value"
        value={source}
        onChange={setSource}
        connected={connected}
        valueDescription="Stored encrypted and never shown again."
      />
    </EditorSheet>
  );
}

/** One secret a plugin needs: adding it, or editing and removing it from the row menu. */
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
  const path = pluginSettingPath(pluginId, setting.key);
  const managers = useQuery(passwordManagersQuery).data ?? [];

  const manager = managers.find((item) => item.id === setting.passwordManager);

  const save = useMutation({
    mutationFn: (input: SettingInput) =>
      input === null ? send(path, "DELETE") : send(path, "PUT", input),
    onSuccess: async () => {
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pluginSettingsQuery.queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: passwordManagersQuery.queryKey,
        }),
        onChange?.(),
      ]);
      // Drop the submitted value from the mutation state.
      save.reset();
    },
  });

  return (
    <>
      <SettingRow
        tile={
          <RowTile>
            <IconKey />
          </RowTile>
        }
        title={
          <>
            {setting.label}
            {manager && (
              <span className="font-normal text-muted-foreground">
                ({manager.name})
              </span>
            )}
          </>
        }
        description={
          !editing &&
          save.isError && <FieldError>{save.error.message}</FieldError>
        }
      >
        {setting.configured ? (
          <RowMenu>
            <DropdownMenuItem onClick={() => setEditing(true)}>
              <IconPencil />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={save.isPending}
              onClick={() => save.mutate(null)}
            >
              <IconTrash />
              Remove
            </DropdownMenuItem>
          </RowMenu>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Add
          </Button>
        )}
      </SettingRow>
      {editing && (
        <SecretSettingSheet
          setting={setting}
          error={save.isError ? save.error.message : undefined}
          pending={save.isPending}
          onSave={(input) => save.mutate(input)}
          onClose={() => {
            setEditing(false);
            save.reset();
          }}
        />
      )}
    </>
  );
}

/** The settings of every plugin that contributes `contributes`, as the server declares them. */
export function PluginSettingRows({
  contributes,
  secretKey,
  onChange,
}: {
  contributes: Contribution;
  /** Limits the rows to the setting stored under this key, `pluginId:key`. */
  secretKey?: string;
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
      plugin.settings
        .filter(
          (setting) =>
            secretKey === undefined ||
            `${plugin.id}:${setting.key}` === secretKey,
        )
        .map((setting) => (
          <SecretSetting
            key={`${plugin.id}/${setting.key}`}
            pluginId={plugin.id}
            setting={setting}
            onChange={onChange}
          />
        )),
    );
}
