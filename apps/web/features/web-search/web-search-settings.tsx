import { useMutation, useQuery } from "@tanstack/react-query";
import { IconWorld } from "@tabler/icons-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  RowTile,
  Section,
  SectionError,
  SettingRow,
  Page,
} from "@/components/page";
import { api, call, queryClient } from "@/lib/api";
import { isWebSearchProviderId, webSearchProviders } from "./web-search";
import { PluginSettingRows } from "@/features/plugin-settings/plugin-settings";

const webSearchSettingsQuery = {
  queryKey: ["web-search-settings"],
  queryFn: () => api<"getWebSearch">("/v1/web-search"),
};

const refresh = () =>
  queryClient.invalidateQueries({ queryKey: webSearchSettingsQuery.queryKey });

/** The account's web search: which provider bots use, and the keys its providers need. */
export function WebSearchPage() {
  const settings = useQuery(webSearchSettingsQuery);

  const change = useMutation({
    mutationFn: (defaultProvider: (typeof webSearchProviders)[number]["id"]) =>
      call<"updateWebSearch">("/v1/web-search", "PUT", { defaultProvider }),
    onSuccess: refresh,
  });

  const data = settings.data;

  return (
    <Page title="Web search">
      <Section
        title="Search provider"
        description="Bots use this unless their own settings choose another provider."
      >
        {settings.isError && (
          <SectionError>{settings.error.message}</SectionError>
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
              select={{ contributes: "webSearchProviders" }}
              onChange={refresh}
            />
          </>
        )}
      </Section>
    </Page>
  );
}
