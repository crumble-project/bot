import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { clearUserData } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

type Mode = "sign-in" | "sign-up";

const MODE_COPY = {
  "sign-in": {
    submit: "Sign in",
    switch: "Create an account",
    other: "sign-up",
    autoComplete: "current-password",
  },
  "sign-up": {
    submit: "Create account",
    switch: "Already have an account? Sign in",
    other: "sign-in",
    autoComplete: "new-password",
  },
} as const;

function useConnect(
  mode: Mode,
  credentials: { email: string; password: string; name: string },
) {
  const { email, password, name } = credentials;

  return useMutation({
    mutationFn: async () => {
      const result =
        mode === "sign-in"
          ? await authClient.signIn.email({ email, password })
          : await authClient.signUp.email({ email, password, name });

      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: async () => {
      clearUserData();
      window.location.assign("/ui/");
    },
  });
}

function canConnect(
  mode: Mode,
  { email, password, name }: { email: string; password: string; name: string },
) {
  return Boolean(
    email.trim() && password && (mode !== "sign-up" || name.trim()),
  );
}

export function Connect() {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const credentials = { email, password, name };
  const copy = MODE_COPY[mode];

  const connect = useConnect(mode, credentials);

  return (
    <form
      className="mx-auto mt-[20vh] w-full max-w-xs px-4"
      onSubmit={(event) => {
        event.preventDefault();
        connect.mutate();
      }}
    >
      <FieldGroup>
        <h1 className="font-heading text-xl font-semibold">Crumble</h1>
        {mode === "sign-up" && (
          <Field>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}
        <Field data-invalid={connect.isError || undefined}>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoFocus
            autoComplete="email"
            aria-invalid={connect.isError || undefined}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field data-invalid={connect.isError || undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete={copy.autoComplete}
            aria-invalid={connect.isError || undefined}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {connect.isError && <FieldError>{connect.error.message}</FieldError>}
        </Field>
        <Button
          type="submit"
          disabled={!canConnect(mode, credentials) || connect.isPending}
        >
          {copy.submit}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMode(copy.other);
            connect.reset();
          }}
        >
          {copy.switch}
        </Button>
      </FieldGroup>
    </form>
  );
}
