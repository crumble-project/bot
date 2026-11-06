import { type ComponentType, Fragment, useState } from "react";
import type { UseQueryOptions } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { NewButton, PageToolbar, Page } from "@/components/page";
import type { Bot } from "@/features/bots/api";
import { ALL, useBotQueries } from "@/features/bots/queries";
import {
  ActionFailure,
  type BotEntry,
  BotPills,
  DeleteSecretDialog,
  type Named,
  SecretGroups,
  type SecretRequest,
  type Target,
  useSecretActions,
} from "./bot-secrets";

export type SecretRowProps<I> = {
  item: I;
  onEdit: () => void;
  onUses: () => void;
  onDelete: () => void;
};

type SheetProps<I, R> = {
  bots: Bot[];
  botId: string | null;
  existing: I | null;
  request: R | undefined;
  onClose: () => void;
};

type SecretPageText = {
  title: string;
  searchLabel: string;
  newLabel: string;
  pillsLabel: string;
  empty: string;
  noMatch: string;
  note: string;
  deleteDescription: string;
};

type Editing<I, R> = Pick<SheetProps<I, R>, "botId" | "existing" | "request">;

type SecretPageProps<D, I, R> = {
  text: SecretPageText;
  initialBot: string | undefined;
  queryOf: (botId: string) => UseQueryOptions<D, Error, D, string[]>;
  pathOf: Parameters<typeof useSecretActions>[0];
  refresh: (botId: string) => Promise<void>;
  itemsOf: (data: D) => I[];
  requestsOf: (data: D) => R[];
  Row: ComponentType<SecretRowProps<I>>;
  Uses: ComponentType<{ target: Target<I>; onClose: () => void }>;
  Sheet: ComponentType<SheetProps<I, R>>;
};

function useSecretPage<D, I extends Named, R extends SecretRequest>(
  initialBot: string | undefined,
  queryOf: SecretPageProps<D, I, R>["queryOf"],
  pathOf: SecretPageProps<D, I, R>["pathOf"],
  refresh: SecretPageProps<D, I, R>["refresh"],
) {
  const { bots, entries, refreshing } = useBotQueries(queryOf);
  const [scope, setScope] = useState(initialBot ?? ALL);
  const [search, setSearch] = useState("");
  const actions = useSecretActions<I>(pathOf, refresh);
  const [editing, setEditing] = useState<Editing<I, R> | null>(null);

  const startNew = () =>
    setEditing({
      botId: scope === ALL ? null : scope,
      existing: null,
      request: undefined,
    });

  return {
    bots,
    entries,
    refreshing,
    scope,
    setScope,
    search,
    setSearch,
    actions,
    editing,
    setEditing,
    startNew,
  };
}

type SecretPageState<D, I extends Named, R extends SecretRequest> = ReturnType<
  typeof useSecretPage<D, I, R>
>;

function SecretList<D, I extends Named, R extends SecretRequest>({
  page: { entries, scope, search, actions, setEditing: onEdit },
  itemsOf,
  requestsOf,
  text,
  Row,
}: {
  page: SecretPageState<D, I, R>;
  itemsOf: (data: D) => I[];
  requestsOf: (data: D) => R[];
  text: SecretPageText;
  Row: ComponentType<SecretRowProps<I>>;
}) {
  return (
    <SecretGroups
      entries={entries}
      scope={scope}
      needle={search.trim().toLowerCase()}
      itemsOf={itemsOf}
      requestsOf={requestsOf}
      onAdd={(botId, request) => onEdit({ botId, existing: null, request })}
      onDecline={(botId, name) => actions.decline.mutate({ botId, item: name })}
      empty={text.empty}
      noMatch={text.noMatch}
      note={text.note}
    >
      {(botId, item) => (
        <Fragment key={item.name}>
          <Row
            item={item}
            onEdit={() => onEdit({ botId, existing: item, request: undefined })}
            onUses={() => actions.setUses({ botId, item })}
            onDelete={() => actions.setDeleting({ botId, item: item.name })}
          />
        </Fragment>
      )}
    </SecretGroups>
  );
}

function SecretControls<D, I extends Named, R extends SecretRequest>({
  page: { bots, entries, scope, setScope, search, setSearch, startNew },
  text,
  countOf,
}: {
  page: SecretPageState<D, I, R>;
  text: SecretPageText;
  countOf: (entry: BotEntry<D>) => number;
}) {
  return (
    <div className="flex flex-col gap-3">
      <PageToolbar
        search={search}
        searchLabel={text.searchLabel}
        onSearch={setSearch}
      >
        <NewButton
          label={text.newLabel}
          disabled={!bots.data?.length}
          onClick={startNew}
        />
      </PageToolbar>
      <BotPills
        label={text.pillsLabel}
        entries={entries}
        scope={scope}
        onScope={setScope}
        countOf={countOf}
      />
    </div>
  );
}

function SecretOverlays<I extends Named, R extends SecretRequest>({
  bots,
  editing,
  onCloseEditor,
  actions,
  deleteDescription,
  Uses,
  Sheet,
}: {
  bots: Bot[];
  editing: Editing<I, R> | null;
  onCloseEditor: () => void;
  actions: ReturnType<typeof useSecretActions<I>>;
  deleteDescription: string;
  Uses: ComponentType<{ target: Target<I>; onClose: () => void }>;
  Sheet: ComponentType<SheetProps<I, R>>;
}) {
  return (
    <>
      {editing && <Sheet bots={bots} {...editing} onClose={onCloseEditor} />}
      {actions.uses && (
        <Uses target={actions.uses} onClose={() => actions.setUses(null)} />
      )}
      <DeleteSecretDialog actions={actions} description={deleteDescription} />
    </>
  );
}

export function SecretPage<D, I extends Named, R extends SecretRequest>({
  text,
  initialBot,
  queryOf,
  pathOf,
  refresh,
  itemsOf,
  requestsOf,
  Row,
  Uses,
  Sheet,
}: SecretPageProps<D, I, R>) {
  const page = useSecretPage<D, I, R>(initialBot, queryOf, pathOf, refresh);
  const { bots, entries, refreshing, editing, actions } = page;

  const countOf = ({ query }: BotEntry<D>) =>
    query.data ? itemsOf(query.data).length + requestsOf(query.data).length : 0;

  return (
    <Page
      title={text.title}
      refreshing={refreshing}
      onRefresh={() =>
        void Promise.all(entries.map((entry) => refresh(entry.bot.id)))
      }
    >
      <SecretControls page={page} text={text} countOf={countOf} />
      <ActionFailure actions={actions} />
      {bots.isPending ? (
        <Skeleton className="h-40 rounded-xl" />
      ) : (
        <SecretList
          page={page}
          itemsOf={itemsOf}
          requestsOf={requestsOf}
          text={text}
          Row={Row}
        />
      )}
      <SecretOverlays
        bots={bots.data ?? []}
        editing={editing}
        onCloseEditor={() => page.setEditing(null)}
        actions={actions}
        deleteDescription={text.deleteDescription}
        Uses={Uses}
        Sheet={Sheet}
      />
    </Page>
  );
}
