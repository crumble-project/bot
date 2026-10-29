import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconKey, IconPlugConnectedX } from "@tabler/icons-react";
import { si1password, siBitwarden, type SimpleIcon } from "simple-icons";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { BrandLogo } from "@/components/brand-logo";
import { EditorSheet } from "@/components/form-fields";
import {
  RowMenu,
  RowTile,
  Section,
  SectionEmpty,
  SettingRow,
  WorkspacePage,
} from "@/components/workspace";
import {
  type PasswordManager,
  passwordManagerPath,
  passwordManagersQuery,
  queryClient,
  send,
} from "@/lib/api";

const LOGOS = {
  "1password": si1password,
  bitwarden: siBitwarden,
} as const satisfies Record<PasswordManager["id"], SimpleIcon>;

const TOKEN_LABELS = {
  "1password": "Service account token",
  bitwarden: "Access token",
} as const satisfies Record<PasswordManager["id"], string>;

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: passwordManagersQuery.queryKey });

function TokenSheet({
  manager,
  onClose,
}: {
  manager: PasswordManager;
  onClose: () => void;
}) {
  const [token, setToken] = useState("");

  const connect = useMutation({
    mutationFn: () =>
      send(passwordManagerPath(manager.id), "PUT", { token: token.trim() }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  return (
    <EditorSheet
      title={
        manager.connected
          ? `Replace ${manager.name} token`
          : `Connect ${manager.name}`
      }
      description="Crumble signs in once to check the token and stores it encrypted. It only reads secrets you point it at."
      error={connect.error?.message}
      submitLabel={manager.connected ? "Save" : "Connect"}
      submitDisabled={token.trim() === "" || connect.isPending}
      onSubmit={() => connect.mutate()}
      onClose={onClose}
    >
      <Field>
        <FieldLabel htmlFor="password-manager-token">
          {TOKEN_LABELS[manager.id]}
        </FieldLabel>
        <Input
          id="password-manager-token"
          type="password"
          autoComplete="off"
          autoFocus
          value={token}
          onChange={(event) => setToken(event.target.value)}
        />
        {manager.connected && (
          <FieldDescription>
            Values read with the old token are dropped.
          </FieldDescription>
        )}
      </Field>
    </EditorSheet>
  );
}

function PasswordManagerRow({ manager }: { manager: PasswordManager }) {
  const [editing, setEditing] = useState(false);
  const inUse = manager.usedBy.length > 0;

  const disconnect = useMutation({
    mutationFn: () => send(passwordManagerPath(manager.id), "DELETE"),
    onSuccess: refresh,
  });

  return (
    <SettingRow
      tile={
        <RowTile>
          <BrandLogo icon={LOGOS[manager.id]} />
        </RowTile>
      }
      title={
        <>
          {manager.name}
          {inUse && (
            <span className="font-normal text-muted-foreground">
              (used by {manager.usedBy.length})
            </span>
          )}
        </>
      }
      description={
        disconnect.isError && (
          <FieldError>{disconnect.error.message}</FieldError>
        )
      }
    >
      {manager.connected ? (
        <RowMenu>
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <IconKey />
            Replace token
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={inUse || disconnect.isPending}
            onClick={() => disconnect.mutate()}
          >
            <IconPlugConnectedX />
            {inUse ? "Disconnect (in use)" : "Disconnect"}
          </DropdownMenuItem>
        </RowMenu>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Connect
        </Button>
      )}
      {editing && (
        <TokenSheet manager={manager} onClose={() => setEditing(false)} />
      )}
    </SettingRow>
  );
}

/** The account's password managers: connecting one with a token, replacing it, and disconnecting it. */
export function PasswordManagersPage() {
  const managers = useQuery(passwordManagersQuery);

  return (
    <WorkspacePage title="Password managers">
      <Section
        title="Password managers"
        description="Credentials, provider API keys, and MCP server tokens can be read from a connected password manager instead of being stored in Crumble."
      >
        {managers.isError && (
          <div className="p-3">
            <FieldError>{managers.error.message}</FieldError>
          </div>
        )}
        {managers.isPending && <SectionEmpty>Loading…</SectionEmpty>}
        {managers.data?.map((manager) => (
          <PasswordManagerRow key={manager.id} manager={manager} />
        ))}
      </Section>
    </WorkspacePage>
  );
}
