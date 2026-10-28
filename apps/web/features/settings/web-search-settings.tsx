import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, call, queryClient, send } from "@/lib/api";

export type WebSearchSettings = {
  defaultProvider: "mixed" | "exa";
  exaKeyConfigured: boolean;
};

export const webSearchSettingsQuery = {
  queryKey: ["web-search-settings"],
  queryFn: () => api<WebSearchSettings>("/v1/web-search"),
};

const options = [
  { label: "Mixed", value: "mixed" },
  { label: "Exa", value: "exa" },
];

export function WebSearchSettingsSection() {
  const settings = useQuery(webSearchSettingsQuery);
  const [key, setKey] = useState("");

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: webSearchSettingsQuery.queryKey,
    });

  const change = useMutation({
    mutationFn: (defaultProvider: WebSearchSettings["defaultProvider"]) =>
      call<
        WebSearchSettings,
        { defaultProvider: WebSearchSettings["defaultProvider"] }
      >("/v1/web-search", "PUT", { defaultProvider }),
    onSuccess: refresh,
  });

  const saveKey = useMutation({
    mutationFn: (apiKey: string | null) =>
      apiKey === null
        ? send("/v1/web-search/exa-key", "DELETE")
        : send("/v1/web-search/exa-key", "PUT", { apiKey }),
    onSuccess: async () => {
      setKey("");
      await refresh();
      saveKey.reset();
    },
  });

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="font-medium">Web search</h2>
        <p className="text-sm text-muted-foreground">
          Bots use the account default unless you choose another provider in
          their settings. Keys are shared by bots on this account.
        </p>
      </div>
      {settings.isError && <FieldError>{settings.error.message}</FieldError>}
      {settings.data && (
        <>
          <Field>
            <FieldLabel htmlFor="web-search-default">
              Default web search provider
            </FieldLabel>
            <Select
              items={options}
              value={settings.data.defaultProvider}
              onValueChange={(value) => {
                if (value === "mixed" || value === "exa") change.mutate(value);
              }}
            >
              <SelectTrigger id="web-search-default" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="mixed">Mixed</SelectItem>
                  <SelectItem value="exa">Exa</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              Mixed works without a key. Exa requires an API key.
            </FieldDescription>
            {change.isError && <FieldError>{change.error.message}</FieldError>}
          </Field>
          <form
            onSubmit={(event) => {
              event.preventDefault();

              if (key.trim()) saveKey.mutate(key.trim());
            }}
          >
            <Field>
              <FieldLabel htmlFor="web-search-exa-key">Exa API key</FieldLabel>
              <FieldDescription>
                {settings.data.exaKeyConfigured
                  ? "A key is saved. Enter a new key to replace it."
                  : "Add a key to use Exa."}
              </FieldDescription>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="web-search-exa-key"
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="API key"
                />
                <Button
                  type="submit"
                  disabled={!key.trim() || saveKey.isPending}
                >
                  Save key
                </Button>
                {settings.data.exaKeyConfigured && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saveKey.isPending}
                    onClick={() => saveKey.mutate(null)}
                  >
                    Remove key
                  </Button>
                )}
              </div>
              {saveKey.isError && (
                <FieldError>{saveKey.error.message}</FieldError>
              )}
            </Field>
          </form>
        </>
      )}
    </section>
  );
}
