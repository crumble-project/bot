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
  invalidateSecrets,
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

function useSaveSecretSetting(
  path: ReturnType<typeof pluginSettingPath>,
  onSaved: () => void,
  onChange: (() => Promise<void>) | undefined,
) {
  const save = useMutation({
    mutationFn: (input: SecretInput | null) =>
      input === null
        ? send<"deletePluginSetting">(path, "DELETE")
        : send<"setPluginSetting">(path, "PUT", input),
    onSuccess: async () => {
      onSaved();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: pluginSettingsQuery.queryKey,
        }),
        invalidateSecrets(),
        onChange?.(),
      ]);
      // Drop the submitted value from the mutation state.
      save.reset();
    },
  });

  return save;
}

function SecretSettingTitle({ setting }: { setting: Setting }) {
  const managers = useQuery(passwordManagersQuery).data ?? [];

  const manager = managers.find(
    (item) => item.id === setting.secret.passwordManager,
  );

  return (
    <>
      {setting.label}
      {manager && (
        <span className="font-normal text-muted-foreground">
          ({manager.name})
        </span>
      )}
    </>
  );
}

function SecretSettingActions({
  configured,
  pending,
  onEdit,
  onRemove,
}: {
  configured: boolean;
  pending: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  if (!configured)
    return (
      <Button variant="outline" size="sm" onClick={onEdit}>
        Add
      </Button>
    );

  return (
    <RowMenu>
      <DropdownMenuItem onClick={onEdit}>
        <IconPencil />
        Edit
      </DropdownMenuItem>
      <DropdownMenuItem
        variant="destructive"
        disabled={pending}
        onClick={onRemove}
      >
        <IconTrash />
        Remove
      </DropdownMenuItem>
    </RowMenu>
  );
}

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
  const save = useSaveSecretSetting(path, () => setEditing(false), onChange);

  return (
    <>
      <SettingRow
        tile={
          <RowTile>
            <IconKey />
          </RowTile>
        }
        title={<SecretSettingTitle setting={setting} />}
        description={
          !editing &&
          save.isError && <FieldError>{save.error.message}</FieldError>
        }
      >
        <SecretSettingActions
          configured={setting.secret.configured}
          pending={save.isPending}
          onEdit={() => setEditing(true)}
          onRemove={() => save.mutate(null)}
        />
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

export function PluginSettingRows({
  select,
  onChange,
}: {
  select: SettingSelection;
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
