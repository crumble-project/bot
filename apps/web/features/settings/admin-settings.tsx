import { useState } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import {
  IconClock,
  IconCpu,
  IconLink,
  IconPackage,
  IconShieldCheck,
  IconShieldOff,
  IconTrash,
  IconUserPlus,
} from "@tabler/icons-react";
import type {
  adminUser,
  invite,
  serverSettingsSchema,
} from "@crumble/server/contract/admin";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { CopyButton, EditorSheet } from "@/components/form-fields";
import {
  RowMenu,
  RowTile,
  Section,
  SectionEmpty,
  SettingRow,
  WorkspacePage,
} from "@/components/workspace";
import { api, call, capabilitiesQuery, queryClient, send } from "@/lib/api";
import { useSession } from "@/lib/auth-client";

type AdminUser = z.infer<typeof adminUser>;

type Invite = z.infer<typeof invite>;

type ServerSettings = z.infer<typeof serverSettingsSchema>;

const usersQuery = queryOptions({
  queryKey: ["admin", "users"],
  queryFn: () => api<{ users: AdminUser[] }>("/v1/admin/users"),
});

const invitesQuery = queryOptions({
  queryKey: ["admin", "invites"],
  queryFn: () => api<{ invites: Invite[] }>("/v1/admin/invites"),
});

const serverSettingsQuery = queryOptions({
  queryKey: ["admin", "settings"],
  queryFn: () => api<ServerSettings>("/v1/admin/settings"),
});

const refreshAdmin = () =>
  queryClient.invalidateQueries({ queryKey: ["admin"] });

export function useIsAdmin() {
  return useSession().data?.user.role === "admin";
}

function UserRow({ user, self }: { user: AdminUser; self: boolean }) {
  const change = useMutation({
    mutationFn: (action: "admin" | "user" | "remove") =>
      action === "remove"
        ? send(`/v1/admin/users/${encodeURIComponent(user.id)}`, "DELETE")
        : send(`/v1/admin/users/${encodeURIComponent(user.id)}`, "PATCH", {
            role: action,
          }),
    onSettled: refreshAdmin,
  });

  const shown = user.name || user.email;

  return (
    <>
      <SettingRow
        tile={
          <RowTile className="font-heading text-sm font-semibold text-foreground">
            {shown.slice(0, 1).toUpperCase()}
          </RowTile>
        }
        title={
          <span className="truncate">
            {shown}
            {user.role === "admin" && (
              <span className="text-muted-foreground"> (admin)</span>
            )}
          </span>
        }
      >
        {!self && (
          <RowMenu>
            {user.role === "admin" ? (
              <DropdownMenuItem onClick={() => change.mutate("user")}>
                <IconShieldOff />
                Make regular user
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => change.mutate("admin")}>
                <IconShieldCheck />
                Make admin
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              disabled={change.isPending}
              onClick={() => change.mutate("remove")}
            >
              <IconTrash />
              Remove account and data
            </DropdownMenuItem>
          </RowMenu>
        )}
      </SettingRow>
      {change.isError && (
        <div className="p-3">
          <FieldError>{change.error.message}</FieldError>
        </div>
      )}
    </>
  );
}

function InviteRow({ invite }: { invite: Invite }) {
  const revoke = useMutation({
    mutationFn: () =>
      send(`/v1/admin/invites/${encodeURIComponent(invite.id)}`, "DELETE"),
    onSettled: refreshAdmin,
  });

  return (
    <SettingRow
      tile={
        <RowTile>
          <IconLink />
        </RowTile>
      }
      title={`Invite from ${new Date(invite.createdAt).toLocaleDateString()}`}
    >
      <Button
        variant="outline"
        size="sm"
        disabled={revoke.isPending}
        onClick={() => revoke.mutate()}
      >
        Revoke
      </Button>
    </SettingRow>
  );
}

/** Shows a new invite link once: the server keeps only its hash. */
function NewInviteSheet({ onClose }: { onClose: () => void }) {
  const create = useQuery({
    queryKey: ["admin", "new-invite"],
    queryFn: () => call<Invite & { url: string }>("/v1/admin/invites", "POST"),
    staleTime: Infinity,
    gcTime: 0,
  });

  return (
    <EditorSheet
      title="Invite link"
      description="Anyone with this link can create one account. It's shown only now."
      error={create.error?.message}
      submitLabel="Done"
      submitDisabled={false}
      onSubmit={onClose}
      onClose={onClose}
    >
      {create.data ? (
        <div className="flex items-center gap-2">
          <Input readOnly value={create.data.url} className="font-mono" />
          <CopyButton text={create.data.url} />
        </div>
      ) : (
        <Skeleton className="h-9 w-full" />
      )}
    </EditorSheet>
  );
}

function Users() {
  const users = useQuery(usersQuery);
  const invites = useQuery(invitesQuery);
  const session = useSession();
  const [inviting, setInviting] = useState(false);

  return (
    <Section
      title="Users"
      action={
        <Button variant="outline" size="sm" onClick={() => setInviting(true)}>
          <IconUserPlus data-icon="inline-start" />
          Invite
        </Button>
      }
    >
      {users.isPending && <Skeleton className="m-3 h-5 w-40" />}
      {users.data?.users.map((user) => (
        <UserRow
          key={user.id}
          user={user}
          self={user.id === session.data?.user.id}
        />
      ))}
      {invites.data?.invites.map((entry) => (
        <InviteRow key={entry.id} invite={entry} />
      ))}
      {(users.error ?? invites.error) && (
        <div className="p-3">
          <FieldError>{(users.error ?? invites.error)?.message}</FieldError>
        </div>
      )}
      {inviting && (
        <NewInviteSheet
          onClose={() => {
            setInviting(false);
            void refreshAdmin();
          }}
        />
      )}
    </Section>
  );
}

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
    String(settings.workspaceMemoryMib / 1024),
  );

  const [image, setImage] = useState(settings.codingImage ?? "");
  const [grace, setGrace] = useState(String(settings.questionGraceMinutes));

  const save = useMutation({
    mutationFn: (patch: Partial<ServerSettings>) =>
      send("/v1/admin/settings", "PATCH", patch),
    onSuccess: async () => {
      await refreshAdmin();
      onClose();
    },
  });

  const patch = (): Partial<ServerSettings> => {
    switch (editing) {
      case "size":
        return {
          workspaceCpus: Number(cpus),
          workspaceMemoryMib: Math.round(Number(memory) * 1024),
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

/** Who may join: open sign-up, or invite links only. */
function SignUp() {
  const settings = useQuery(serverSettingsQuery);

  const signUp = useMutation({
    mutationFn: (signUpOpen: boolean) =>
      send("/v1/admin/settings", "PATCH", { signUpOpen }),
    onSettled: refreshAdmin,
  });

  return (
    <Section title="Sign-up">
      <SettingRow
        tile={
          <RowTile>
            <IconUserPlus />
          </RowTile>
        }
        title={<label htmlFor="sign-up">Open sign-up</label>}
      >
        {settings.data ? (
          <Switch
            id="sign-up"
            checked={settings.data.signUpOpen}
            disabled={signUp.isPending}
            onCheckedChange={(next) => signUp.mutate(next)}
          />
        ) : (
          <Skeleton className="h-5 w-9" />
        )}
      </SettingRow>
      {(settings.error ?? signUp.error) && (
        <div className="p-3">
          <FieldError>{(settings.error ?? signUp.error)?.message}</FieldError>
        </div>
      )}
    </Section>
  );
}

/** Settings > Users: the server's accounts, invite links, and sign-up. Admins only. */
export function UsersPage() {
  const admin = useIsAdmin();

  return (
    <WorkspacePage title="Users">
      {admin ? (
        <>
          <Users />
          <SignUp />
        </>
      ) : (
        <Section title="Users">
          <SectionEmpty>Only admins manage users.</SectionEmpty>
        </Section>
      )}
    </WorkspacePage>
  );
}

const HELP = {
  coding: "Coding jobs need CRUMBLE_WORKSPACE_IMAGE on the server.",
  desktop: "Desktop jobs need CRUMBLE_WORKSPACE_DESKTOP_IMAGE on the server.",
};

/** The workspace settings every bot shares, on the Coding page; only admins can change them. */
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
          title: `Workspace size (${data.workspaceCpus} CPUs, ${data.workspaceMemoryMib / 1024} GB)`,
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
        <div className="p-3">
          <FieldError>{settings.error.message}</FieldError>
        </div>
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
