import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { DOORSTEP_PLUGIN_ID } from "@crumble/server/contract/plugins";
import { IconTrash, IconWebhook } from "@tabler/icons-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { CopyButton, EditorSheet } from "@/components/form-fields";
import {
  ConfirmDelete,
  NewButton,
  RowTile,
  Section,
  SectionEmpty,
  SectionError,
  SettingRow,
  UsedBy,
  Page,
} from "@/components/page";
import { call, queryClient, send } from "@/lib/api";
import {
  eventRelayQuery,
  eventSourcePath,
  eventSourcesQuery,
  type EventSource,
  type RelayStatus,
} from "./api";
import { PluginSettingRows } from "@/features/plugin-settings/plugin-settings";
import { MAX_EVENT_SOURCE_NAME_CHARS } from "@crumble/server/contract/event-sources";

const refresh = () =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: eventRelayQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: eventSourcesQuery.queryKey }),
  ]).then(() => undefined);

const STATUS_LABELS: Record<RelayStatus["status"], string> = {
  disconnected: "Not set up",
  connecting: "Connecting",
  connected: "Connected",
  error: "Connection error",
};

function RelayTile() {
  return (
    <RowTile>
      <IconWebhook />
    </RowTile>
  );
}

function RelayBadge({ relay }: { relay: RelayStatus }) {
  return (
    <Badge variant={relay.status === "error" ? "destructive" : "secondary"}>
      {STATUS_LABELS[relay.status]}
    </Badge>
  );
}

function RelayUrlRow({ relay }: { relay: RelayStatus }) {
  const [url, setUrl] = useState(relay.url ?? "");

  const save = useMutation({
    mutationFn: (next: string | null) =>
      call<"updateEventRelay">("/v1/event-relay", "PUT", { url: next }),
    onSuccess: (next) => {
      queryClient.setQueryData(eventRelayQuery.queryKey, next);
      setUrl(next.url ?? "");
    },
  });

  const next = url.trim() || null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(next);
      }}
    >
      <SettingRow
        tile={<RelayTile />}
        title={
          <>
            <label htmlFor="event-relay-url">Relay URL</label>
            <RelayBadge relay={relay} />
          </>
        }
        description={save.error?.message}
      >
        <Input
          id="event-relay-url"
          type="url"
          className="w-56 sm:w-72"
          placeholder="https://relay.example.com"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          disabled={save.isPending || next === relay.url}
        >
          Save
        </Button>
      </SettingRow>
    </form>
  );
}

function RelaySection() {
  const relay = useQuery(eventRelayQuery);

  return (
    <Section
      title="Relay"
      description="A Doorstep relay receives webhooks for this account and forwards them to this server, so the server needs no public address."
    >
      {relay.isError && <SectionError>{relay.error.message}</SectionError>}
      {relay.data && (
        <>
          <RelayUrlRow key={relay.data.url ?? ""} relay={relay.data} />
          {relay.data.error && (
            <div className="p-3">
              <Alert variant="destructive">
                <AlertTitle>Relay needs attention</AlertTitle>
                <AlertDescription>{relay.data.error}</AlertDescription>
              </Alert>
            </div>
          )}
          <PluginSettingRows
            select={{ pluginId: DOORSTEP_PLUGIN_ID }}
            onChange={refresh}
          />
        </>
      )}
    </Section>
  );
}

function SourceRow({ source }: { source: EventSource }) {
  const remove = useMutation({
    mutationFn: () =>
      send<"deleteEventSource">(eventSourcePath(source.id), "DELETE"),
    onSuccess: refresh,
  });

  return (
    <SettingRow
      tile={<RelayTile />}
      title={
        <>
          <span className="truncate">{source.name}</span>
          <UsedBy count={source.usedBy} />
        </>
      }
      description={remove.error?.message}
    >
      <ConfirmDelete
        title={`Delete ${source.name}?`}
        description="Its webhook address stops working. Events that already arrived are kept."
        onConfirm={() => remove.mutate()}
        trigger={
          <Button
            variant="ghost"
            size="icon-sm"
            title={
              source.usedBy
                ? "Remove the automations that use it first"
                : "Delete"
            }
            disabled={source.usedBy > 0 || remove.isPending}
          >
            <IconTrash />
          </Button>
        }
      />
    </SettingRow>
  );
}

function SourceAddressField({ address }: { address: string }) {
  return (
    <Field>
      <FieldLabel htmlFor="event-source-address">Webhook address</FieldLabel>
      <div className="flex items-center gap-1">
        <Input
          id="event-source-address"
          readOnly
          value={address}
          onFocus={(event) => event.target.select()}
        />
        <CopyButton text={address} />
      </div>
      <FieldDescription>
        Shown once. Paste it into the provider's webhook settings.
      </FieldDescription>
    </Field>
  );
}

function AddSourceSheet({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: (value: string) =>
      call<"createEventSource">("/v1/event-sources", "POST", { name: value }),
    onSuccess: refresh,
  });

  const created = create.data;

  if (created)
    return (
      <EditorSheet
        title={`${created.name} address`}
        submitLabel="Done"
        submitDisabled={false}
        onSubmit={onClose}
        onClose={onClose}
      >
        <SourceAddressField address={created.address} />
      </EditorSheet>
    );

  return (
    <EditorSheet
      title="Add event source"
      description="Crumble creates the source on the relay and shows its webhook address once."
      error={create.error?.message}
      submitLabel="Add"
      submitDisabled={!name.trim() || create.isPending}
      onSubmit={() => create.mutate(name.trim())}
      onClose={onClose}
    >
      <Field>
        <FieldLabel htmlFor="event-source-name">Name</FieldLabel>
        <Input
          id="event-source-name"
          placeholder="GitHub issues"
          maxLength={MAX_EVENT_SOURCE_NAME_CHARS}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
    </EditorSheet>
  );
}

function SourcesSection() {
  const sources = useQuery(eventSourcesQuery);
  const [adding, setAdding] = useState(false);

  return (
    <Section
      title="Event sources"
      description="Each source is one webhook address. Automations that use a source run when an event arrives there."
      action={<NewButton label="Add source" onClick={() => setAdding(true)} />}
    >
      {sources.isError && <SectionError>{sources.error.message}</SectionError>}
      {sources.data?.length === 0 && (
        <SectionEmpty>No event sources yet.</SectionEmpty>
      )}
      {sources.data?.map((source) => (
        <SourceRow key={source.id} source={source} />
      ))}
      {adding && <AddSourceSheet onClose={() => setAdding(false)} />}
    </Section>
  );
}

export function EventRelayPage() {
  const relay = useQuery(eventRelayQuery);

  return (
    <Page
      title="Event relay"
      onRefresh={() => void refresh()}
      refreshing={relay.isFetching}
    >
      <RelaySection />
      <SourcesSection />
    </Page>
  );
}
