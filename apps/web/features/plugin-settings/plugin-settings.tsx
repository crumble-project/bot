import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { pluginSettingKey } from "@crumble/server/contract/plugins";
import { IconKey, IconPencil, IconTrash } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { EditorSheet } from "@/components/form-fields";
import {
  SecretSourceField,
  type SecretInput,
  useSecretDraft,
} from "@/features/password-managers/secret-source-field";
import { RowMenu, RowTile, SectionError, SettingRow } from "@/components/page";
import {
  type PluginSettings,
  pluginSettingPath,
  pluginSettingsQuery,
} from "./api";
import {
  passwordManagersQuery,
  refreshSecrets,
} from "@/features/password-managers/api";
import { queryClient, send } from "@/lib/api";

type Plugin = PluginSettings["plugins"][number];

type Setting = Plugin["settings"][number];

type Contribution = Plugin["contributes"][number];

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
  onSave: (input: SecretInput) => void;
  onClose: () => void;
}) {
  const secret = useSecretDraft(setting.secret);

  return (
    <EditorSheet
      title={setting.label}
      error={error}
      submitLabel="Save"
      submitDisabled={pending || !secret.changed}
      onSubmit={() => secret.input && onSave(secret.input)}
      onClose={onClose}
    >
      <SecretSourceField
        id={`plugin-setting-${setting.key}`}
        label="Value"
        {...secret.field}
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

  const manager = managers.find(
    (item) => item.id === setting.secret.passwordManager,
  );

  const save = useMutation({
    mutationFn: (input: SecretInput | null) =>
      input === null
        ? send<"deletePluginSetting">(path, "DELETE")
        : send<"setPluginSetting">(path, "PUT", input),
    onSuccess: async () => {
      setEditing(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pluginSettingsQuery.queryKey,
        }),
        refreshSecrets(),
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
        {setting.secret.configured ? (
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

/** Which settings a page shows: a contribution's plugins, one plugin, or the setting stored under a key. */
type SettingSelection =
  | { contributes: Contribution }
  | { pluginId: string }
  | { secretKey: string };

function isSelected(
  select: SettingSelection,
  plugin: Plugin,
  setting: Setting,
) {
  if ("contributes" in select)
    return plugin.contributes.includes(select.contributes);

  if ("pluginId" in select) return plugin.id === select.pluginId;

  return pluginSettingKey(plugin.id, setting.key) === select.secretKey;
}

/** The selected plugin settings, as the server declares them. */
export function PluginSettingRows({
  select,
  onChange,
}: {
  select: SettingSelection;
  /** Runs after a value is saved or removed, for pages whose own status depends on it. */
  onChange?: () => Promise<void>;
}) {
  const settings = useQuery(pluginSettingsQuery);

  if (settings.isError)
    return <SectionError>{settings.error.message}</SectionError>;

  return settings.data?.plugins.flatMap((plugin) =>
    plugin.settings
      .filter((setting) => isSelected(select, plugin, setting))
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
