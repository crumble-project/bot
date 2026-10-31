import { useMutation, useQuery } from "@tanstack/react-query";
import { IconWorld } from "@tabler/icons-react";
import { FieldError } from "@/components/ui/field";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  RowTile,
  Section,
  SettingRow,
  WorkspacePage,
} from "@/components/workspace";
import { api, type Bot, call, queryClient } from "@/lib/api";
import { PluginSettingRows } from "./plugin-settings";

type WebSearchProviderId = NonNullable<Bot["webSearchProvider"]>;

/** The name of each web search provider the server offers; a provider the server adds needs one here. */
const providerNames: Record<WebSearchProviderId, string> = {
  mixed: "Mixed",
  exa: "Exa",
};

export const isWebSearchProviderId = (
  value: string,
): value is WebSearchProviderId => Object.hasOwn(providerNames, value);

export const webSearchProviders = Object.entries(providerNames).flatMap(
  ([id, name]) => (isWebSearchProviderId(id) ? [{ id, name }] : []),
);

export type WebSearchSettings = {
  defaultProvider: WebSearchProviderId;
  exaKeyConfigured: boolean;
};

export const webSearchSettingsQuery = {
  queryKey: ["web-search-settings"],
  queryFn: () => api<WebSearchSettings>("/v1/web-search"),
};

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: webSearchSettingsQuery.queryKey });

/** The account's web search: which provider bots use, and the keys its providers need. */
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
                  if (isWebSearchProviderId(value)) change.mutate(value);
                }}
              >
                <TabsList aria-label="Default web search provider">
                  {webSearchProviders.map((provider) => (
                    <TabsTrigger key={provider.id} value={provider.id}>
                      {provider.name}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </SettingRow>
            <PluginSettingRows
              contributes="webSearchProviders"
              onChange={refresh}
            />
          </>
        )}
      </Section>
    </WorkspacePage>
  );
}
