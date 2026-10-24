import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import { LinkSquare02Icon } from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  HttpError,
  type LoginSession,
  type Provider,
  api,
  loginQuery,
  providersQuery,
  queryClient,
  send,
} from "./api";

export async function refreshProviders() {
  await queryClient.invalidateQueries({ queryKey: providersQuery.queryKey });
  await queryClient.invalidateQueries({ queryKey: ["models"] });
}

/** Runs a provider's account sign-in; closing keeps it going on the server so it can be continued. */
export function LoginDialog({
  provider,
  onClose,
}: {
  provider: Provider;
  onClose: () => void;
}) {
  const [sessionId, setSessionId] = useState(provider.activeLoginId);
  const path = `/v1/providers/${encodeURIComponent(provider.provider)}/login`;

  const start = useMutation({
    mutationFn: () =>
      api<LoginSession>(path, {
        method: "POST",
        body: JSON.stringify({ method: "oauth" }),
      }),
    onSuccess: async (session) => {
      setSessionId(session.id);
      await refreshProviders();
    },
  });

  const session = useQuery({
    ...loginQuery(sessionId ?? ""),
    enabled: sessionId !== null,
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      send(`/v1/provider-logins/${encodeURIComponent(id)}`, "DELETE"),
    onSettled: async () => {
      await refreshProviders();
      onClose();
    },
  });

  const status = session.data?.status;

  useEffect(() => {
    if (status && status !== "pending") void refreshProviders();
  }, [status]);

  const gone =
    session.error instanceof HttpError && session.error.status === 410;

  const failure = start.error ?? (gone ? null : session.error);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sign in to {provider.name}</DialogTitle>
          <DialogDescription>
            The server keeps this sign-in. Bots that use {provider.name} share
            it.
          </DialogDescription>
        </DialogHeader>
        {sessionId === null ? (
          <Button disabled={start.isPending} onClick={() => start.mutate()}>
            {start.isPending && <Spinner data-icon="inline-start" />}
            Start sign-in
          </Button>
        ) : gone ? (
          <Alert>
            <AlertDescription>
              This sign-in ended or was lost on restart. Close this and start
              again.
            </AlertDescription>
          </Alert>
        ) : session.data ? (
          <LoginSteps session={session.data} />
        ) : (
          <Spinner />
        )}
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure.message}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          {sessionId !== null && status === "pending" && (
            <Button
              variant="ghost"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(sessionId)}
            >
              Cancel sign-in
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {status === "pending" ? "Hide" : "Close"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LoginSteps({ session }: { session: LoginSession }) {
  if (session.status === "succeeded")
    return (
      <Alert>
        <AlertDescription>Signed in.</AlertDescription>
      </Alert>
    );

  if (session.status !== "pending")
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {session.failure?.message ?? `Sign-in ${session.status}.`}
        </AlertDescription>
      </Alert>
    );

  return (
    <div className="flex flex-col gap-4">
      {session.events.map((event, index) => {
        switch (event.type) {
          case "auth_url":
            return (
              <div key={index} className="flex flex-col gap-2">
                {event.instructions && (
                  <p className="text-sm">{event.instructions}</p>
                )}
                <Button
                  render={
                    <a
                      href={event.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    />
                  }
                  nativeButton={false}
                >
                  Open sign-in page
                  <HugeiconsIcon
                    icon={LinkSquare02Icon}
                    data-icon="inline-end"
                  />
                </Button>
              </div>
            );
          case "device_code":
            return (
              <div key={index} className="flex flex-col gap-2 text-sm">
                <p>
                  Enter this code at{" "}
                  <a
                    className="underline underline-offset-2"
                    href={event.verificationUri}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {event.verificationUri}
                  </a>
                  :
                </p>
                <code className="self-start rounded-md bg-muted px-3 py-2 font-mono text-lg tracking-widest">
                  {event.userCode}
                </code>
              </div>
            );
          case "info":
            return (
              <p key={index} className="text-sm text-muted-foreground">
                {event.message}{" "}
                {event.links?.map((link) => (
                  <a
                    key={link.url}
                    className="underline underline-offset-2"
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {link.label ?? link.url}
                  </a>
                ))}
              </p>
            );
          case "progress":
            return index === session.events.length - 1 ? (
              <p key={index} className="shimmer text-sm">
                {event.message}
              </p>
            ) : null;
        }
      })}
      {session.prompt ? (
        <PromptForm key={session.prompt.id} session={session} />
      ) : (
        session.events.at(-1)?.type !== "progress" && (
          <p className="shimmer text-sm">Waiting for the provider…</p>
        )
      )}
    </div>
  );
}

function PromptForm({ session }: { session: LoginSession }) {
  const prompt = session.prompt!;
  const [value, setValue] = useState("");

  const answer = useMutation({
    mutationFn: (answer: string) =>
      api<LoginSession>(
        `/v1/provider-logins/${encodeURIComponent(session.id)}/responses`,
        {
          method: "POST",
          body: JSON.stringify({ promptId: prompt.id, value: answer }),
        },
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(loginQuery(session.id).queryKey, next);
      // Answers can be secrets; keep them out of the mutation state.
      answer.reset();
    },
  });

  if (prompt.type === "select")
    return (
      <FieldGroup>
        <p className="text-sm">{prompt.message}</p>
        {prompt.options?.map((option) => (
          <Button
            key={option.id}
            variant="outline"
            className="h-auto flex-col items-start py-2"
            disabled={answer.isPending}
            onClick={() => answer.mutate(option.id)}
          >
            {option.label}
            {option.description && (
              <span className="text-xs font-normal text-muted-foreground">
                {option.description}
              </span>
            )}
          </Button>
        ))}
        {answer.isError && (
          <p className="text-sm text-destructive">{answer.error.message}</p>
        )}
      </FieldGroup>
    );

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();

        if (value.trim()) answer.mutate(value.trim());
      }}
    >
      <FieldGroup>
        <Field data-invalid={answer.isError || undefined}>
          <FieldLabel htmlFor="login-answer">{prompt.message}</FieldLabel>
          <Input
            id="login-answer"
            type={prompt.type === "secret" ? "password" : "text"}
            autoComplete="off"
            placeholder={prompt.placeholder}
            aria-invalid={answer.isError || undefined}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {answer.isError && (
            <p className="text-sm text-destructive">{answer.error.message}</p>
          )}
        </Field>
        <Button type="submit" disabled={!value.trim() || answer.isPending}>
          Continue
        </Button>
      </FieldGroup>
    </form>
  );
}
