import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { type Provider, providersQuery, queryClient, send } from "./api";

export function Settings() {
  const providers = useQuery(providersQuery);

  return (
    <div className="flex-1 overflow-y-auto">
      <FieldSet className="mx-auto w-full max-w-2xl p-6">
        <FieldLegend>Providers</FieldLegend>
        <FieldDescription>
          API keys are stored encrypted on the server and never shown again.
        </FieldDescription>
        {providers.isPending && <Skeleton className="h-40" />}
        {providers.isError && (
          <FieldError>{providers.error.message}</FieldError>
        )}
        <FieldGroup>
          {providers.data?.map((provider, index) => (
            <ProviderField
              key={provider.provider}
              provider={provider}
              separator={index > 0}
            />
          ))}
        </FieldGroup>
      </FieldSet>
    </div>
  );
}

function ProviderField({
  provider,
  separator,
}: {
  provider: Provider;
  separator: boolean;
}) {
  const [key, setKey] = useState("");
  const path = `/v1/providers/${encodeURIComponent(provider.provider)}`;
  const id = `provider-${provider.provider}`;

  const save = useMutation({
    mutationFn: (apiKey: string | null) =>
      apiKey === null ? send(path, "DELETE") : send(path, "PUT", { apiKey }),
    onSuccess: async () => {
      setKey("");
      await queryClient.invalidateQueries({
        queryKey: providersQuery.queryKey,
      });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      // Drop the submitted key from the mutation state.
      save.reset();
    },
  });

  return (
    <>
      {separator && <FieldSeparator />}
      <form
        onSubmit={(event) => {
          event.preventDefault();

          if (key.trim()) save.mutate(key.trim());
        }}
      >
        <Field data-invalid={save.isError || undefined}>
          <FieldContent className="flex-row items-center gap-2">
            <FieldLabel htmlFor={id}>{provider.name}</FieldLabel>
            {provider.configured && (
              <Badge variant="secondary">Configured</Badge>
            )}
          </FieldContent>
          <div className="flex gap-2">
            <Input
              id={id}
              type="password"
              autoComplete="off"
              placeholder={provider.configured ? "Replace API key" : "API key"}
              aria-invalid={save.isError || undefined}
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <Button type="submit" disabled={!key.trim() || save.isPending}>
              Save
            </Button>
            {provider.configured && (
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                Remove
              </Button>
            )}
          </div>
          {save.isError && <FieldError>{save.error.message}</FieldError>}
        </Field>
      </form>
    </>
  );
}
