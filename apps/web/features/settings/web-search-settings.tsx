import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { IconKey, IconWorld } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SecretForm } from "@/components/form-fields";
import {
  RowTile,
  Section,
  SettingRow,
  StatusDot,
  WorkspacePage,
} from "@/components/workspace";
import { api, call, queryClient, send } from "@/lib/api";

export type WebSearchSettings = {
  defaultProvider: "mixed" | "exa";
  exaKeyConfigured: boolean;
};

export const webSearchSettingsQuery = {
  queryKey: ["web-search-settings"],
  queryFn: () => api<WebSearchSettings>("/v1/web-search"),
};

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: webSearchSettingsQuery.queryKey });

function ExaKey({ configured }: { configured: boolean }) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState("");

  const save = useMutation({
    mutationFn: (apiKey: string | null) =>
      apiKey === null
        ? send("/v1/web-search/exa-key", "DELETE")
        : send("/v1/web-search/exa-key", "PUT", { apiKey }),
    onSuccess: async () => {
      setKey("");
      setEditing(false);
      await refresh();
      // Drop the submitted key from the mutation state.
      save.reset();
    },
  });

  return (
    <div className="flex flex-col">
      <SettingRow
        tile={
          <RowTile>
            <IconKey />
          </RowTile>
        }
        title="Exa API key"
        description={
          <StatusDot
            on={configured}
            label={configured ? "Saved" : "Needed for Exa"}
          />
        }
      >
        {!editing && (
          <Button
            variant={configured ? "ghost" : "outline"}
            size="sm"
            onClick={() => setEditing(true)}
          >
            {configured ? "Replace" : "Add key"}
          </Button>
        )}
        {configured && !editing && (
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => save.mutate(null)}
          >
            Remove
          </Button>
        )}
      </SettingRow>
      <ExaKeyEditor
        editing={editing}
        error={save.isError ? save.error.message : undefined}
        value={key}
        pending={save.isPending}
        onChange={setKey}
        onSave={() => save.mutate(key.trim())}
        onCancel={() => {
          setEditing(false);
          setKey("");
        }}
      />
    </div>
  );
}

/** The account's web search: which provider bots use, and the Exa key. */
function ExaKeyEditor({
  editing,
  error,
  value,
  pending,
  onChange,
  onSave,
  onCancel,
}: {
  editing: boolean;
  error: string | undefined;
  value: string;
  pending: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!editing && error === undefined) return null;

  return (
    <div className="flex flex-col gap-2 px-3 pb-3 pl-14">
      {editing && (
        <SecretForm
          label="Exa API key"
          value={value}
          pending={pending}
          onChange={onChange}
          onSave={onSave}
          onCancel={onCancel}
        />
      )}
      {error !== undefined && <FieldError>{error}</FieldError>}
    </div>
  );
}

export function WebSearchPage() {
  const settings = useQuery(webSearchSettingsQuery);

  const change = useMutation({
    mutationFn: (defaultProvider: WebSearchSettings["defaultProvider"]) =>
      call<
        WebSearchSettings,
        { defaultProvider: WebSearchSettings["defaultProvider"] }
      >("/v1/web-search", "PUT", { defaultProvider }),
    onSuccess: refresh,
  });

  const data = settings.data;

  return (
    <WorkspacePage title="Web search">
      <Section
        title="Search provider"
        description="Bots use this unless their own settings choose another provider."
      >
        {settings.isError && (
          <div className="p-3">
            <FieldError>{settings.error.message}</FieldError>
          </div>
        )}
        {data && (
          <>
            <SettingRow
              tile={
                <RowTile>
                  <IconWorld />
                </RowTile>
              }
              title="Default"
              description={
                data.defaultProvider === "exa" && !data.exaKeyConfigured
                  ? "Exa needs a key before bots can search with it."
                  : change.error?.message
              }
            >
              <Tabs
                value={data.defaultProvider}
                onValueChange={(value) => {
                  if (value === "mixed" || value === "exa")
                    change.mutate(value);
                }}
              >
                <TabsList aria-label="Default web search provider">
                  <TabsTrigger value="mixed">Mixed</TabsTrigger>
                  <TabsTrigger value="exa">Exa</TabsTrigger>
                </TabsList>
              </Tabs>
            </SettingRow>
            <ExaKey configured={data.exaKeyConfigured} />
          </>
        )}
      </Section>
    </WorkspacePage>
  );
}
