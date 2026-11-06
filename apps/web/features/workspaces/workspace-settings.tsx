import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconClock, IconCpu, IconPackage } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EditorSheet } from "@/components/form-fields";
import {
  RowTile,
  Section,
  SectionEmpty,
  SectionError,
  SettingRow,
} from "@/components/page";
import { capabilitiesQuery } from "@/features/bots/api";
import { send } from "@/lib/api";
import { useIsAdmin } from "@/lib/auth-client";
import {
  type ServerSettings,
  invalidateAdmin,
  serverSettingsQuery,
} from "@/features/settings/api";

const MIB_PER_GB = 1024;

const gigabytes = (mib: number) => mib / MIB_PER_GB;

type Editing = "size" | "image" | "grace" | undefined;

function NumberField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function SettingsSheet({
  editing,
  settings,
  onClose,
}: {
  editing: Exclude<Editing, undefined>;
  settings: ServerSettings;
  onClose: () => void;
}) {
  const [cpus, setCpus] = useState(String(settings.workspaceCpus));

  const [memory, setMemory] = useState(
    String(gigabytes(settings.workspaceMemoryMib)),
  );

  const [image, setImage] = useState(settings.codingImage ?? "");
  const [grace, setGrace] = useState(String(settings.questionGraceMinutes));

  const save = useMutation({
    mutationFn: (patch: Partial<ServerSettings>) =>
      send<"updateServerSettings">("/v1/admin/settings", "PATCH", patch),
    onSuccess: async () => {
      await invalidateAdmin();
      onClose();
    },
  });

  const patch = (): Partial<ServerSettings> => {
    switch (editing) {
      case "size":
        return {
          workspaceCpus: Number(cpus),
          workspaceMemoryMib: Math.round(Number(memory) * MIB_PER_GB),
        };
      case "image":
        return { codingImage: image.trim() || null };
      case "grace":
        return { questionGraceMinutes: Number(grace) };
    }
  };

  const titles = {
    size: "Workspace size",
    image: "Coding image",
    grace: "Question grace period",
  };

  return (
    <EditorSheet
      title={titles[editing]}
      error={save.error?.message}
      submitLabel="Save"
      submitDisabled={save.isPending}
      onSubmit={() => save.mutate(patch())}
      onClose={onClose}
    >
      {editing === "size" && (
        <>
          <NumberField id="cpus" label="CPUs" value={cpus} onChange={setCpus} />
          <NumberField
            id="memory"
            label="Memory (GB)"
            value={memory}
            onChange={setMemory}
          />
        </>
      )}
      {editing === "image" && (
        <Field>
          <FieldLabel htmlFor="image">Image</FieldLabel>
          <Input
            id="image"
            className="font-mono"
            placeholder="ghcr.io/owner/image:tag"
            value={image}
            onChange={(event) => setImage(event.target.value)}
          />
        </Field>
      )}
      {editing === "grace" && (
        <NumberField
          id="grace"
          label="Minutes"
          value={grace}
          onChange={setGrace}
        />
      )}
    </EditorSheet>
  );
}

const HELP = {
  coding: "Coding jobs need CRUMBLE_WORKSPACE_IMAGE on the server.",
  desktop: "Desktop jobs need CRUMBLE_WORKSPACE_DESKTOP_IMAGE on the server.",
};

export function WorkspaceSettings() {
  const admin = useIsAdmin();
  const capabilities = useQuery(capabilitiesQuery);
  const settings = useQuery({ ...serverSettingsQuery, enabled: admin });
  const [editing, setEditing] = useState<Editing>();

  const missing = capabilities.isSuccess
    ? (["coding", "desktop"] as const).filter(
        (kind) => capabilities.data[kind] !== true,
      )
    : [];

  if (!admin && !missing.length) return null;
  const data = settings.data;

  const rows = data
    ? [
        {
          key: "size" as const,
          icon: IconCpu,
          title: `Workspace size (${data.workspaceCpus} CPUs, ${gigabytes(data.workspaceMemoryMib)} GB)`,
        },
        {
          key: "image" as const,
          icon: IconPackage,
          title: `Coding image (${data.codingImage ?? "server default"})`,
        },
        {
          key: "grace" as const,
          icon: IconClock,
          title: `Question grace period (${data.questionGraceMinutes} min)`,
        },
      ]
    : [];

  return (
    <Section title="Workspaces">
      {missing.map((kind) => (
        <SectionEmpty key={kind}>
          <span className="font-mono text-xs">{HELP[kind]}</span>
        </SectionEmpty>
      ))}
      {admin && settings.isPending && <Skeleton className="m-3 h-5 w-40" />}
      {rows.map((row) => (
        <SettingRow
          key={row.key}
          tile={
            <RowTile>
              <row.icon />
            </RowTile>
          }
          title={<span className="truncate">{row.title}</span>}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditing(row.key)}
          >
            Edit
          </Button>
        </SettingRow>
      ))}
      {settings.isError && (
        <SectionError>{settings.error.message}</SectionError>
      )}
      {editing && data && (
        <SettingsSheet
          editing={editing}
          settings={data}
          onClose={() => setEditing(undefined)}
        />
      )}
    </Section>
  );
}
