import { useState } from "react";
import { queryOptions, useMutation, useQuery } from "@tanstack/react-query";
import type { z } from "@hono/zod-openapi";
import {
  IconLink,
  IconShieldCheck,
  IconShieldOff,
  IconTrash,
  IconUserPlus,
} from "@tabler/icons-react";
import type { adminUser, invite } from "@crumble/server/contract/admin";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { CopyButton, EditorSheet } from "@/components/form-fields";
import {
  RowMenu,
  RowTile,
  Section,
  SectionEmpty,
  SectionError,
  SettingRow,
  Page,
} from "@/components/page";
import { api, call, send } from "@/lib/api";
import { useIsAdmin, useSession } from "@/lib/auth-client";
import { refreshAdmin, serverSettingsQuery } from "./api";

type AdminUser = z.infer<typeof adminUser>;

type Invite = z.infer<typeof invite>;

const usersQuery = queryOptions({
  queryKey: ["admin", "users"],
  queryFn: () => api<"adminUsers">("/v1/admin/users"),
});

const invitesQuery = queryOptions({
  queryKey: ["admin", "invites"],
  queryFn: () => api<"invites">("/v1/admin/invites"),
});

const userPath = (id: string) =>
  `/v1/admin/users/${encodeURIComponent(id)}` as const;

const invitePath = (id: string) =>
  `/v1/admin/invites/${encodeURIComponent(id)}` as const;

function UserRow({ user, self }: { user: AdminUser; self: boolean }) {
  const change = useMutation({
    mutationFn: (action: "admin" | "user" | "remove") =>
      action === "remove"
        ? send<"removeUser">(userPath(user.id), "DELETE")
        : send<"setUserRole">(userPath(user.id), "PATCH", { role: action }),
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
      {change.isError && <SectionError>{change.error.message}</SectionError>}
    </>
  );
}

function InviteRow({ invite }: { invite: Invite }) {
  const revoke = useMutation({
    mutationFn: () => send<"revokeInvite">(invitePath(invite.id), "DELETE"),
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
    // Outside ["admin"]: `refreshAdmin` would POST again and mint an invite nobody sees.
    queryKey: ["new-invite"],
    queryFn: () => call<"createInvite">("/v1/admin/invites", "POST"),
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
        <SectionError>{(users.error ?? invites.error)?.message}</SectionError>
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

/** Who may join: open sign-up, or invite links only. */
function SignUp() {
  const settings = useQuery(serverSettingsQuery);

  const signUp = useMutation({
    mutationFn: (signUpOpen: boolean) =>
      send<"updateServerSettings">("/v1/admin/settings", "PATCH", {
        signUpOpen,
      }),
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
        <SectionError>{(settings.error ?? signUp.error)?.message}</SectionError>
      )}
    </Section>
  );
}

/** Settings > Users: the server's accounts, invite links, and sign-up. Admins only. */
export function UsersPage() {
  const admin = useIsAdmin();

  return (
    <Page title="Users">
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
    </Page>
  );
}
