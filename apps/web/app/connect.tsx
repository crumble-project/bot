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
import {
  authClient,
  INVITE_HEADER,
  passkeyDone,
  passkeysAvailable,
} from "@/lib/auth-client";

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

/** The invite token of an invite link, which opens the page on sign-up. */
const invite = new URLSearchParams(location.search).get("invite") ?? undefined;

function enter() {
  clearUserData();
  window.location.assign("/");
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
          : await authClient.signUp.email({
              email,
              password,
              name,
              ...(invite && {
                fetchOptions: { headers: { [INVITE_HEADER]: invite } },
              }),
            });

      if (result.error) throw new Error(result.error.message);
    },
    onSuccess: enter,
  });
}

/** Creates the account with a passkey alone; the server creates the user once the passkey verifies. */
function usePasskeySignUp(credentials: { email: string; name: string }) {
  const { email, name } = credentials;

  return useMutation({
    mutationFn: async () =>
      passkeyDone(
        await authClient.passkey.addPasskey({
          context: JSON.stringify({
            email: email.trim(),
            name: name.trim(),
            ...(invite && { invite }),
          }),
          createSession: true,
        }),
      ),
    onSuccess: (done) => done && enter(),
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

/** The passkey button for the mode: sign in with one, or create the account with one alone. */
function PasskeyAction({
  mode,
  credentials,
  onStart,
}: {
  mode: Mode;
  credentials: { email: string; name: string };
  onStart: () => void;
}) {
  const signIn = usePasskeySignIn(mode);
  const signUp = usePasskeySignUp(credentials);
  const action = mode === "sign-in" ? signIn : signUp;

  const ready =
    mode === "sign-in" ||
    Boolean(credentials.email.trim() && credentials.name.trim());

  if (!passkeysAvailable) return null;

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={!ready || action.isPending}
        onClick={() => {
          onStart();
          action.mutate();
        }}
      >
        {mode === "sign-in"
          ? "Sign in with a passkey"
          : "Create account with a passkey"}
      </Button>
      {action.error && <FieldError>{action.error.message}</FieldError>}
    </>
  );
}

export function Connect() {
  const [mode, setMode] = useState<Mode>(invite ? "sign-up" : "sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const credentials = { email, password, name };
  const copy = MODE_COPY[mode];

  const connect = useConnect(mode, credentials);
  const error = connect.error;
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
        <PasskeyAction
          key={mode}
          mode={mode}
          credentials={credentials}
          onStart={connect.reset}
        />
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
