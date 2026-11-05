import { IconHistory } from "@tabler/icons-react";
import {
  type Login,
  type LoginUse,
  type Logins,
  loginPath,
  loginsQuery,
  refreshLogins,
} from "./api";
import {
  LastUse,
  SecretRowMenu,
  SecretRowName,
  UsesDialog,
  type Target,
} from "@/features/bot-secrets/bot-secrets";
import {
  SecretPage,
  type SecretRowProps,
} from "@/features/bot-secrets/secret-page";
import { LoginSheet } from "./login-sheet";
import { api } from "@/lib/api";
import { BOT_SECRET_USE_RETENTION_DAYS } from "@crumble/server/contract/limits";

const FIELD_LABELS = {
  username: "Username",
  password: "Password",
  one_time_code: "One-time code",
} as const satisfies Record<LoginUse["field"], string>;

const loginsOf = (data: Logins) => data.logins;

const requestsOf = (data: Logins) => data.requests;

function LoginRow({
  item: login,
  onEdit,
  onUses,
  onDelete,
}: SecretRowProps<Login>) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 transition-colors hover:bg-muted/50">
      <SecretRowName name={login.name} hosts={login.hosts} onEdit={onEdit} />
      <LastUse
        lastUsedAt={login.lastUsedAt}
        lastError={login.lastError}
        used="Filled"
        never="Never filled"
      />
      <SecretRowMenu
        uses={
          <>
            <IconHistory />
            Fills
          </>
        }
        onUses={onUses}
        onEdit={onEdit}
        onDelete={onDelete}
      />
    </div>
  );
}

function FillsDialog({
  target,
  onClose,
}: {
  target: Target<Login>;
  onClose: () => void;
}) {
  const { botId, item } = target;

  return (
    <UsesDialog<LoginUse>
      title={`Fills of ${item.name}`}
      description={`Fields desktop jobs filled in the last ${BOT_SECRET_USE_RETENTION_DAYS} days, newest first.`}
      empty="Not filled yet."
      queryKey={["login-uses", botId, item.name]}
      load={(query, signal) =>
        api<"agentLoginUses">(`${loginPath(botId, item.name)}/uses?${query}`, {
          signal,
        })
      }
      onClose={onClose}
    >
      {(use) => (
        <>
          <span className="min-w-0 flex-1 truncate text-xs">
            {FIELD_LABELS[use.field]} on {use.host}
          </span>
          {use.error && (
            <span
              className="max-w-64 shrink truncate text-xs text-destructive"
              title={use.error}
            >
              {use.error}
            </span>
          )}
        </>
      )}
    </UsesDialog>
  );
}

export function LoginsSettings({
  initialBot,
}: {
  initialBot?: string | undefined;
}) {
  return (
    <SecretPage
      text={{
        title: "Logins",
        searchLabel: "Search logins",
        newLabel: "New login",
        pillsLabel: "Whose logins",
        empty:
          "None yet. The bot asks for one when a desktop job needs to sign in.",
        noMatch: "No logins match your search.",
        note: `Desktop jobs fill a login only into https pages on its hosts, and never see its password. Fills are kept for ${BOT_SECRET_USE_RETENTION_DAYS} days.`,
        deleteDescription:
          "Desktop jobs can no longer fill it, and its fills are deleted. This cannot be undone.",
      }}
      initialBot={initialBot}
      queryOf={loginsQuery}
      pathOf={loginPath}
      refresh={refreshLogins}
      itemsOf={loginsOf}
      requestsOf={requestsOf}
      Row={LoginRow}
      Uses={FillsDialog}
      Sheet={LoginSheet}
    />
  );
}
