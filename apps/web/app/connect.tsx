import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { WebAuthnAbortService } from "@simplewebauthn/browser";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { clearUserData } from "@/lib/api";
import { authClient, passkeyDone, passkeysAvailable } from "@/lib/auth-client";

type Mode = "sign-in" | "sign-up";

const MODE_COPY = {
  "sign-in": {
    submit: "Sign in",
    switch: "Create an account",
    other: "sign-up",
    autoComplete: "current-password",
    emailAutoComplete: passkeysAvailable ? "email webauthn" : "email",
  },
  "sign-up": {
    submit: "Create account",
    switch: "Already have an account? Sign in",
    other: "sign-in",
    autoComplete: "new-password",
    emailAutoComplete: "email",
  },
} as const;

function enter() {
  clearUserData();
  window.location.assign("/ui/");
}

/** Signs in with a passkey: from the button, or from the browser's autofill on the email field. */
function usePasskeySignIn(mode: Mode) {
  // Bumped after a manual attempt that didn't sign in, which aborted the autofill request.
  const [attempt, setAttempt] = useState(0);

  const signIn = useMutation({
    mutationFn: async () => passkeyDone(await authClient.signIn.passkey()),
    onSuccess: (done) => (done ? enter() : setAttempt((n) => n + 1)),
    onError: () => setAttempt((n) => n + 1),
  });

  useEffect(() => {
    if (mode !== "sign-in" || !passkeysAvailable) return;
    let cancelled = false;

    void (async () => {
      const available =
        await PublicKeyCredential.isConditionalMediationAvailable?.();

      if (!available || cancelled) return;

      try {
        if (passkeyDone(await authClient.signIn.passkey({ autoFill: true })))
          enter();
      } catch {
        // A failed autofill sign-in leaves the form for another try.
      }
    })();

    return () => {
      cancelled = true;
      WebAuthnAbortService.cancelCeremony();
    };
  }, [mode, attempt]);

  return signIn;
}

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
    onSuccess: enter,
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
  const passkey = usePasskeySignIn(mode);
  const error = connect.error ?? passkey.error;
  const invalid = connect.isError || undefined;

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
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            type="email"
            autoFocus
            autoComplete={copy.emailAutoComplete}
            aria-invalid={invalid}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </Field>
        <Field data-invalid={invalid}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete={copy.autoComplete}
            aria-invalid={invalid}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          {error && <FieldError>{error.message}</FieldError>}
        </Field>
        <Button
          type="submit"
          disabled={!canConnect(mode, credentials) || connect.isPending}
        >
          {copy.submit}
        </Button>
        {mode === "sign-in" && passkeysAvailable && (
          <Button
            type="button"
            variant="outline"
            disabled={passkey.isPending}
            onClick={() => {
              connect.reset();
              passkey.mutate();
            }}
          >
            Sign in with a passkey
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setMode(copy.other);
            connect.reset();
            passkey.reset();
          }}
        >
          {copy.switch}
        </Button>
      </FieldGroup>
    </form>
  );
}
