import { useState } from "react";
import { IconHistory } from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  type Login,
  type LoginRequest,
  type LoginUse,
  type Logins,
  loginPath,
  loginsQuery,
  queryClient,
} from "@/lib/api";
import { NewButton, PageToolbar, WorkspacePage } from "@/components/workspace";
import {
  ALL,
  BotPills,
  DeleteSecretDialog,
  LastUse,
  SecretGroups,
  SecretRowMenu,
  SecretRowName,
  UsesDialog,
  useBotQueries,
  useSecretActions,
  type BotEntry,
  type Target,
} from "@/components/bot-secrets";
import { LoginSheet } from "./login-sheet";

const FIELD_LABELS = {
  username: "Username",
  password: "Password",
  one_time_code: "One-time code",
} as const satisfies Record<LoginUse["field"], string>;

/** What the sheet edits: a login, a request to answer, or a new login. */
type Editing = {
  botId: string | null;
  login: Login | null;
  request?: LoginRequest;
};

const invalidate = (botId: string) =>
  queryClient.invalidateQueries({ queryKey: loginsQuery(botId).queryKey });

const loginsOf = (data: Logins) => data.logins;

const requestsOf = (data: Logins) => data.requests;

const countOf = (entry: BotEntry<Logins>) =>
  (entry.query.data?.logins.length ?? 0) +
  (entry.query.data?.requests.length ?? 0);

function LoginRow({
  login,
  onEdit,
  onUses,
  onDelete,
}: {
  login: Login;
  onEdit: () => void;
  onUses: () => void;
  onDelete: () => void;
}) {
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
      description="Fields desktop jobs filled in the last 90 days, newest first."
      empty="Not filled yet."
      queryKey={["login-uses", botId, item.name]}
      path={`${loginPath(botId, item.name)}/uses`}
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

/** Every bot's logins and requests, with values the owner enters but never sees again. */
export function LoginsSettings({
  initialBot,
}: {
  initialBot?: string | undefined;
}) {
  const { bots, entries, refreshing } = useBotQueries(loginsQuery);
  const [scope, setScope] = useState(initialBot ?? ALL);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const actions = useSecretActions<Login>(loginPath, invalidate);
  const failed = actions.remove.error ?? actions.decline.error;

  return (
    <WorkspacePage
      title="Logins"
      refreshing={refreshing}
      onRefresh={() =>
        void Promise.all(entries.map((entry) => invalidate(entry.bot.id)))
      }
    >
      <div className="flex flex-col gap-3">
        <PageToolbar
          search={search}
          searchLabel="Search logins"
          onSearch={setSearch}
        >
          <NewButton
            label="New login"
            disabled={!bots.data?.length}
            onClick={() =>
              setEditing({ botId: scope === ALL ? null : scope, login: null })
            }
          />
        </PageToolbar>
        <BotPills
          label="Whose logins"
          entries={entries}
          scope={scope}
          onScope={setScope}
          countOf={countOf}
        />
      </div>
      {failed && (
        <Alert variant="destructive">
          <AlertDescription>{failed.message}</AlertDescription>
        </Alert>
      )}
      {bots.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <SecretGroups
          entries={entries}
          scope={scope}
          needle={search.trim().toLowerCase()}
          itemsOf={loginsOf}
          requestsOf={requestsOf}
          onAdd={(botId, request) =>
            setEditing({ botId, login: null, request })
          }
          onDecline={(botId, name) =>
            actions.decline.mutate({ botId, item: name })
          }
          empty="None yet. The bot asks for one when a desktop job needs to sign in."
          noMatch="No logins match your search."
          note="Desktop jobs fill a login only into https pages on its hosts, and never see its password. Fills are kept for 90 days."
        >
          {(botId, login) => (
            <LoginRow
              key={login.name}
              login={login}
              onEdit={() => setEditing({ botId, login })}
              onUses={() => actions.setUses({ botId, item: login })}
              onDelete={() => actions.setDeleting({ botId, item: login.name })}
            />
          )}
        </SecretGroups>
      )}
      {editing && (
        <LoginSheet
          bots={bots.data ?? []}
          botId={editing.botId}
          existing={editing.login}
          request={editing.request}
          onClose={() => setEditing(null)}
        />
      )}
      {actions.uses && (
        <FillsDialog
          target={actions.uses}
          onClose={() => actions.setUses(null)}
        />
      )}
      <DeleteSecretDialog
        actions={actions}
        description="Desktop jobs can no longer fill it, and its fills are deleted. This cannot be undone."
      />
    </WorkspacePage>
  );
}
