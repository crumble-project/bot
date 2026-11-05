import { useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";
import {
  IconBell,
  IconVolume,
  IconFingerprint,
  IconLogout,
  IconPencil,
  IconPlus,
  IconServer,
  IconTrash,
} from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { signedOut } from "@/lib/session";
import { queryClient } from "@/lib/api";
import {
  authClient,
  passkeyDone,
  passkeysAvailable,
  useIsAdmin,
  useSession,
} from "@/lib/auth-client";
import { unlock } from "cuelume";
import { notifications } from "@/lib/notifications";
import { CopyButton } from "@/components/form-fields";
import {
  MobileSidebarTrigger,
  RowMenu,
  RowTile,
  Section,
  SectionEmpty,
  SectionError,
  SettingRow,
  Page,
} from "@/components/page";
import { settingsSections } from "./sections";

/** Settings: a section list beside the open section. */
export function SettingsLayout() {
  const matchRoute = useMatchRoute();
  const admin = useIsAdmin();

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav
        aria-label="Settings"
        className="flex shrink-0 gap-1 overflow-x-auto border-b p-2 md:w-52 md:flex-col md:border-r md:border-b-0 md:p-3"
      >
        <MobileSidebarTrigger className="ml-0" />
        <h2 className="hidden px-2 pt-1 pb-2 font-heading font-semibold md:block">
          Settings
        </h2>
        {settingsSections(admin).map((section) => (
          <Button
            key={section.to}
            variant={
              matchRoute({ to: section.to, fuzzy: true })
                ? "secondary"
                : "ghost"
            }
            className="justify-start"
            render={<Link to={section.to} />}
            nativeButton={false}
          >
            <section.icon data-icon="inline-start" />
            {section.label}
          </Button>
        ))}
      </nav>
      <div
        data-slot="settings-page"
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <Outlet />
      </div>
    </div>
  );
}

const PERMISSION = {
  granted: "Replies from chats you don't have open show as notifications.",
  denied: "Blocked for this site in the browser's settings.",
  default: "The browser asks for permission when you turn this on.",
  unsupported: "This browser doesn't support notifications.",
};

function Notifications() {
  const [enabled, setEnabled] = useState(notifications.enabled);
  const [permission, setPermission] = useState(notifications.permission);
  // Unset defaults to enabled, but nothing shows until the browser grants permission.
  const on = enabled && permission === "granted";
  const [sound, setSound] = useState(notifications.sound);

  return (
    <Section title="Notifications">
      <SettingRow
        tile={
          <RowTile>
            <IconBell />
          </RowTile>
        }
        title={<label htmlFor="notifications">Bot replies</label>}
        description={
          enabled || permission !== "granted"
            ? PERMISSION[permission]
            : "Off on this browser."
        }
      >
        <Switch
          id="notifications"
          checked={on}
          disabled={permission === "unsupported"}
          onCheckedChange={async (next) => {
            setEnabled(next);
            await notifications.setEnabled(next);
            setPermission(notifications.permission());
          }}
        />
      </SettingRow>
      <SettingRow
        tile={
          <RowTile>
            <IconVolume />
          </RowTile>
        }
        title={<label htmlFor="notification-sound">Sound</label>}
      >
        <Switch
          id="notification-sound"
          checked={sound}
          disabled={!on}
          onCheckedChange={async (next) => {
            setSound(next);
            notifications.setSound(next);

            if (next) await unlock();
          }}
        />
      </SettingRow>
    </Section>
  );
}

const passkeysQuery = {
  queryKey: ["passkeys"],
  queryFn: async () => {
    const result = await authClient.passkey.listUserPasskeys();

    if (result.error) throw new Error(result.error.message);

    return result.data;
  },
};

type Passkey = NonNullable<
  Awaited<ReturnType<typeof passkeysQuery.queryFn>>
>[number];

const refreshPasskeys = () =>
  queryClient.invalidateQueries({ queryKey: passkeysQuery.queryKey });

function RenamePasskey({
  passkey,
  onDone,
}: {
  passkey: Passkey;
  onDone: () => void;
}) {
  const [name, setName] = useState(passkey.name ?? "");
  const id = `passkey-${passkey.id}`;

  const rename = useMutation({
    mutationFn: async (next: string) => {
      const result = await authClient.passkey.updatePasskey({
        id: passkey.id,
        name: next,
      });

      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: async () => {
      await refreshPasskeys();
      onDone();
    },
  });

  return (
    <form
      className="flex flex-col gap-2 p-3"
      onSubmit={(event) => {
        event.preventDefault();

        if (name.trim()) rename.mutate(name.trim());
      }}
    >
      <Field data-invalid={rename.isError || undefined}>
        <FieldLabel htmlFor={id} className="sr-only">
          Passkey name
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id={id}
            autoFocus
            autoComplete="off"
            maxLength={100}
            placeholder="Passkey name"
            aria-invalid={rename.isError || undefined}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" disabled={!name.trim() || rename.isPending}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </Field>
      {rename.isError && <FieldError>{rename.error.message}</FieldError>}
    </form>
  );
}

function PasskeyRow({
  passkey,
  removing,
  onRemove,
}: {
  passkey: Passkey;
  removing: boolean;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);

  if (renaming)
    return (
      <RenamePasskey passkey={passkey} onDone={() => setRenaming(false)} />
    );

  return (
    <SettingRow
      tile={
        <RowTile>
          <IconFingerprint />
        </RowTile>
      }
      title={<span className="truncate">{passkey.name || "Passkey"}</span>}
      description={
        <>
          Added {new Date(passkey.createdAt).toLocaleDateString()}
          {passkey.backedUp && " · Synced"}
        </>
      }
    >
      <RowMenu>
        <DropdownMenuItem onClick={() => setRenaming(true)}>
          <IconPencil />
          Rename
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          disabled={removing}
          onClick={onRemove}
        >
          <IconTrash />
          Remove
        </DropdownMenuItem>
      </RowMenu>
    </SettingRow>
  );
}

const PASSKEYS_FOOTER = passkeysAvailable ? (
  <>
    Passkeys belong to {location.hostname}. They stop working if the server's
    address changes.
  </>
) : (
  <>
    Adding a passkey needs a secure address with a hostname, not an IP address.
    Open Crumble at localhost, or set CRUMBLE_PUBLIC_URL on the server.
  </>
);

function PasskeyList({
  passkeys,
  removing,
  onRemove,
}: {
  passkeys: UseQueryResult<Passkey[] | null>;
  removing: boolean;
  onRemove: (id: string) => void;
}) {
  if (passkeys.isPending) return <Skeleton className="m-3 h-5 w-40" />;

  if (!passkeys.data?.length)
    return (
      <SectionEmpty>
        Sign in with your device's screen lock or a security key instead of a
        password.
      </SectionEmpty>
    );

  return passkeys.data.map((passkey) => (
    <PasskeyRow
      key={passkey.id}
      passkey={passkey}
      removing={removing}
      onRemove={() => onRemove(passkey.id)}
    />
  ));
}

function Passkeys() {
  const passkeys = useQuery(passkeysQuery);

  const add = useMutation({
    mutationFn: async () => {
      passkeyDone(await authClient.passkey.addPasskey());
    },
    onSettled: refreshPasskeys,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await authClient.passkey.deletePasskey({ id });

      if (result.error) throw new Error(result.error.message);
    },
    onSettled: refreshPasskeys,
  });

  const error = add.error ?? remove.error ?? passkeys.error;

  // Listing, renaming, and removing need only a session; adding needs WebAuthn.
  return (
    <Section
      title="Passkeys"
      footer={PASSKEYS_FOOTER}
      action={
        passkeysAvailable && (
          <Button
            variant="outline"
            size="sm"
            disabled={add.isPending}
            onClick={() => add.mutate()}
          >
            <IconPlus data-icon="inline-start" />
            Add passkey
          </Button>
        )
      }
    >
      <PasskeyList
        passkeys={passkeys}
        removing={remove.isPending}
        onRemove={(id) => remove.mutate(id)}
      />
      {error && <SectionError>{error.message}</SectionError>}
    </Section>
  );
}

function Account() {
  const session = useSession();
  const user = session.data?.user;

  const signOut = useMutation({
    mutationFn: () => authClient.signOut(),
    onSettled: signedOut,
  });

  const shown = user?.name || user?.email || "Signed in";

  return (
    <Section title="Account">
      <SettingRow
        tile={
          <RowTile className="font-heading text-sm font-semibold text-foreground">
            {shown.slice(0, 1).toUpperCase()}
          </RowTile>
        }
        title={<span className="truncate">{shown}</span>}
        description={user?.name ? user.email : undefined}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          <IconLogout data-icon="inline-start" />
          Sign out
        </Button>
      </SettingRow>
    </Section>
  );
}

function Server() {
  return (
    <Section title="Server">
      <SettingRow
        tile={
          <RowTile>
            <IconServer />
          </RowTile>
        }
        title="Address"
        description={<span className="font-mono">{location.origin}</span>}
      >
        <CopyButton text={location.origin} />
      </SettingRow>
    </Section>
  );
}

export function GeneralSettings() {
  return (
    <Page title="General">
      <Account />
      <Notifications />
      <Passkeys />
      <Server />
    </Page>
  );
}
