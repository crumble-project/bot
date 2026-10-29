import type {
  AuthEvent,
  AuthPrompt,
  AuthType,
  Credential,
  Models,
  Provider,
  ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type {
  loginEvent,
  loginMethod,
  loginPrompt,
  loginSessionResponse,
} from "../contract/api-responses";
import { Context, Effect, Layer, ManagedRuntime, Predicate } from "effect";
import type { ProviderContribution } from "../plugins/plugins";
import { ProviderCredentialRepository } from "./provider-credential-repository";
import { appErrors } from "../shared/app-errors";
import { SettingsRepository } from "../shared/settings-repository";
import type { Runner } from "../shared/runner";
import {
  ProviderCredentials,
  type ProviderCredentialStore,
} from "./provider-credentials";
import { ProviderModels } from "./providers";
import { PasswordManagers } from "../password-managers/password-manager";
import {
  checkSecretReference,
  type SecretReference,
} from "../password-managers/secret-references";
import { SecretValues } from "../password-managers/secret-values";
import {
  InvalidInput,
  NotFound,
  Conflict,
  Gone,
  Unavailable,
  type AppError,
} from "../shared/errors";

export type LoginSession = z.output<typeof loginSessionResponse>;

type LoginMethod = z.output<typeof loginMethod>;

type LoginPrompt = z.output<typeof loginPrompt>;

type LoginEvent = z.output<typeof loginEvent>;

type Failure = NonNullable<LoginSession["failure"]>;

const DEVICE_ID = "provider-auth-device-id";
const INACTIVITY_MS = 10 * 60_000;
const LIFETIME_MS = 30 * 60_000;
const RETAIN_ENDED_MS = 10 * 60_000;
const MAX_ENDED = 64;
const MAX_ACTIVE = 16;
const MAX_EVENTS = 32;
const MAX_EVENT_BYTES = 8192;

/** Installed-library limits that matter when the owner's browser is on another machine. */
const REMOTE_HINTS = new Map([
  [
    "openai",
    "After signing in, your browser opens a page on 127.0.0.1 that may not load. Copy that page's full address and paste it here. The server needs its internal port 1455 free; it does not need to be published.",
  ],
  [
    "radius",
    "Browser sign-in only works with a browser on the server's machine. From another device, choose device code.",
  ],
]);

const FAILURES = {
  provider_failure: "The provider could not complete sign-in. Try again.",
  callback_unavailable:
    "Another sign-in on the server is using this provider's callback port. Finish or cancel it, then try again.",
  storage_failure:
    "The server could not save the credential. Any previous credential is unchanged.",
} satisfies Record<Failure["code"], string>;

type PendingPrompt = {
  prompt: LoginPrompt;
  settle: (value: string) => void;
};

type Session = {
  id: string;
  provider: string;
  method: AuthType;
  status: LoginSession["status"];
  createdAt: number;
  lastActivity: number;
  endedAt?: number;
  prompt: PendingPrompt | null;
  events: LoginEvent[];
  failure: Failure | null;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
};

/** Sign-in methods a provider can run interactively; ambient-only auth has none. */
export function loginMethods(provider: Provider): LoginMethod[] {
  const { apiKey, oauth } = provider.auth;

  return [
    ...(apiKey?.login
      ? [{ type: "api_key" as const, label: apiKey.name, subscription: false }]
      : []),
    ...(oauth
      ? [
          {
            type: "oauth" as const,
            label: oauth.loginLabel ?? oauth.name,
            subscription: oauth.isSubscription ?? false,
          },
        ]
      : []),
  ];
}

/**
 * Relays Pi AI login flows to clients. Sessions live in memory only: a restart ends them, while saved credentials stay
 * encrypted in the database. Raw provider errors never leave this module, because Pi AI can put token responses into
 * them.
 */
export class ProviderSignIns extends Context.Service<
  ProviderSignIns,
  {
    readonly models: Models;
    readonly start: (
      providerId: string,
      method: AuthType,
    ) => Effect.Effect<LoginSession, AppError>;
    readonly get: (sessionId: string) => Effect.Effect<LoginSession, AppError>;
    readonly answer: (
      sessionId: string,
      promptId: string,
      value: string,
    ) => Effect.Effect<LoginSession, AppError>;
    readonly cancel: (
      sessionId: string,
    ) => Effect.Effect<LoginSession, AppError>;
    /** Replaces the saved credential; a pending sign-in for the provider can no longer save its result. */
    readonly setApiKey: (
      providerId: string,
      key: string,
    ) => Effect.Effect<void>;
    /**
     * Reads the API key from a password manager from now on, once the reference reads; a pending sign-in for the
     * provider can no longer save its result.
     */
    readonly setReference: (
      providerId: string,
      source: SecretReference,
    ) => Effect.Effect<void, InvalidInput>;
    /** Removes the saved credential. The provider's grant and any ambient credential stay as they are. */
    readonly signOut: (providerId: string) => Effect.Effect<void>;
    readonly activeLoginId: (providerId: string) => string | null;
  }
>()("crumble/providers/ProviderSignIns") {
  static readonly layer = Layer.effect(
    ProviderSignIns,
    Effect.gen(function* () {
      const settings = yield* SettingsRepository;
      const credentials = yield* ProviderCredentials;
      const models = yield* ProviderModels;
      const managers = yield* PasswordManagers;
      const values = yield* SecretValues;

      const deviceId = () => {
        const saved = Effect.runSync(settings.get(DEVICE_ID));

        if (Predicate.isString(saved) && saved) return saved;
        const created = randomUUID();
        Effect.runSync(settings.set(DEVICE_ID, created));

        return created;
      };

      const sessions = yield* Effect.acquireRelease(
        Effect.sync(() => new SignInSessions(deviceId, credentials, models)),
        (signIns) => Effect.promise(() => signIns.close()),
      );

      return ProviderSignIns.of({
        models,
        start: (providerId, method) =>
          appErrors(Effect.try(() => sessions.start(providerId, method))),
        get: (sessionId) =>
          appErrors(Effect.try(() => sessions.get(sessionId))),
        answer: (sessionId, promptId, value) =>
          appErrors(
            Effect.try(() => sessions.answer(sessionId, promptId, value)),
          ),
        cancel: (sessionId) =>
          appErrors(Effect.try(() => sessions.cancel(sessionId))),
        setApiKey: (providerId, key) =>
          Effect.promise(() => sessions.setApiKey(providerId, key)),
        setReference: (providerId, source) =>
          checkSecretReference(source).pipe(
            Effect.provideService(PasswordManagers, managers),
            Effect.provideService(SecretValues, values),
            Effect.andThen(
              Effect.promise(() => sessions.setReference(providerId, source)),
            ),
          ),
        signOut: (providerId) =>
          Effect.promise(() => sessions.signOut(providerId)),
        activeLoginId: (providerId) => sessions.activeLoginId(providerId),
      });
    }),
  );
}

/** Sign-ins for code outside Effect, such as the HTTP handlers. */
export type ProviderSignInsAccess = {
  readonly models: Models;
  start(providerId: string, method: AuthType): LoginSession;
  get(sessionId: string): LoginSession;
  answer(sessionId: string, promptId: string, value: string): LoginSession;
  cancel(sessionId: string): LoginSession;
  setApiKey(providerId: string, key: string): Promise<void>;
  setReference(providerId: string, source: SecretReference): Promise<void>;
  signOut(providerId: string): Promise<void>;
  activeLoginId(providerId: string): string | null;
};

export function providerSignInsAccess(
  runtime: Runner<ProviderSignIns>,
): ProviderSignInsAccess {
  const signIns = runtime.runSync(ProviderSignIns.use(Effect.succeed));

  return {
    models: signIns.models,
    start: (providerId, method) =>
      runtime.runSync(signIns.start(providerId, method)),
    get: (sessionId) => runtime.runSync(signIns.get(sessionId)),
    answer: (sessionId, promptId, value) =>
      runtime.runSync(signIns.answer(sessionId, promptId, value)),
    cancel: (sessionId) => runtime.runSync(signIns.cancel(sessionId)),
    setApiKey: (providerId, key) =>
      runtime.runPromise(signIns.setApiKey(providerId, key)),
    setReference: (providerId, source) =>
      runtime.runPromise(signIns.setReference(providerId, source)),
    signOut: (providerId) => runtime.runPromise(signIns.signOut(providerId)),
    activeLoginId: signIns.activeLoginId,
  };
}

class SignInSessions {
  private readonly sessions = new Map<string, Session>();
  private readonly active = new Map<string, Session>();
  private readonly flows = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly deviceId: () => string,
    private readonly credentials: ProviderCredentialStore,
    readonly models: Models,
  ) {}

  start(providerId: string, method: AuthType): LoginSession {
    if (this.closed)
      throw new Unavailable({ message: "The server is shutting down" });

    const login = this.loginFor(providerId, method);

    this.reserve(providerId);
    this.prune();

    const session = this.createSession(providerId, method);

    this.sessions.set(session.id, session);
    this.active.set(providerId, session);
    this.schedule(session);
    this.addRemoteHint(session, providerId, method);
    this.beginFlow(session, login);

    return this.project(session);
  }

  get(sessionId: string): LoginSession {
    return this.project(this.session(sessionId));
  }

  answer(sessionId: string, promptId: string, value: string): LoginSession {
    const session = this.session(sessionId);
    const pending = this.awaitingAnswer(session, promptId);

    this.acceptAnswer(session, pending, value);

    return this.project(session);
  }

  cancel(sessionId: string): LoginSession {
    const session = this.session(sessionId);
    this.end(session, "cancelled");

    return this.project(session);
  }

  /** Replaces the saved credential; a pending sign-in for the provider can no longer save its result. */
  async setApiKey(providerId: string, key: string) {
    this.invalidate(providerId);
    await this.credentials.modify(providerId, async () => ({
      type: "api_key",
      key,
    }));
  }

  /** Replaces the saved credential with a checked reference; a pending sign-in can no longer save its result. */
  async setReference(providerId: string, source: SecretReference) {
    this.invalidate(providerId);
    await this.credentials.setReference(providerId, source);
  }

  /** Removes the saved credential. The provider's grant and any ambient credential stay as they are. */
  async signOut(providerId: string) {
    this.invalidate(providerId);
    await this.credentials.delete(providerId);
  }

  activeLoginId(providerId: string) {
    return this.active.get(providerId)?.id ?? null;
  }

  async close() {
    this.closed = true;

    for (const session of this.active.values()) this.end(session, "cancelled");
    await Promise.all(this.flows);
    await this.credentials.idle();
  }

  private loginFor(providerId: string, method: AuthType) {
    const provider = this.models.getProvider(providerId);

    if (!provider) throw new NotFound({ message: "Unknown provider" });
    const login = this.loginFunction(provider, method);

    if (!login)
      throw new InvalidInput({
        message: `${provider.name} does not offer this sign-in`,
      });

    return login;
  }

  private reserve(providerId: string) {
    if (this.active.has(providerId))
      throw new Conflict({
        message: "A sign-in for this provider is in progress",
      });

    if (this.active.size >= MAX_ACTIVE)
      throw new Conflict({ message: "Too many sign-ins are in progress" });
  }

  private createSession(providerId: string, method: AuthType): Session {
    const now = Date.now();

    return {
      id: randomUUID(),
      provider: providerId,
      method,
      status: "pending",
      createdAt: now,
      lastActivity: now,
      prompt: null,
      events: [],
      failure: null,
      controller: new AbortController(),
    };
  }

  private addRemoteHint(
    session: Session,
    providerId: string,
    method: AuthType,
  ) {
    if (method !== "oauth") return;
    const hint = REMOTE_HINTS.get(providerId);

    if (hint) session.events.push({ type: "info", message: hint });
  }

  private beginFlow(
    session: Session,
    login: (interaction: ProviderAuthInteraction) => Promise<Credential>,
  ) {
    const flow = this.run(session, login);

    this.flows.add(flow);
    void flow.finally(() => this.flows.delete(flow));
  }

  private awaitingAnswer(session: Session, promptId: string): PendingPrompt {
    if (session.status !== "pending")
      throw new Conflict({ message: "This sign-in has ended" });
    const pending = session.prompt;

    if (!pending || pending.prompt.id !== promptId)
      throw new Conflict({
        message: "This prompt no longer accepts an answer",
      });

    return pending;
  }

  private acceptAnswer(
    session: Session,
    pending: PendingPrompt,
    value: string,
  ) {
    const { prompt } = pending;

    if (
      prompt.type === "select" &&
      !prompt.options?.some((option) => option.id === value)
    )
      throw new InvalidInput({ message: "Choose one of the offered options" });
    session.lastActivity = Date.now();
    this.schedule(session);
    pending.settle(value);
  }

  private loginFunction(provider: Provider, method: AuthType) {
    const options = {
      agentName: "Crumble",
      getDeviceId: () => this.deviceId(),
    };

    if (method === "oauth") {
      const oauth = provider.auth.oauth;

      return oauth
        ? (interaction: ProviderAuthInteraction) =>
            oauth.login(interaction, options)
        : undefined;
    }

    return provider.auth.apiKey?.login?.bind(provider.auth.apiKey);
  }

  private async run(
    session: Session,
    login: (interaction: ProviderAuthInteraction) => Promise<Credential>,
  ) {
    const credential = await this.authenticate(session, login);

    if (credential) await this.save(session, credential);
  }

  private async authenticate(
    session: Session,
    login: (interaction: ProviderAuthInteraction) => Promise<Credential>,
  ) {
    const { signal } = session.controller;

    try {
      return await abortable(
        login({
          signal,
          prompt: (prompt) => this.prompt(session, prompt),
          notify: (event) => this.notify(session, event),
        }),
        signal,
      );
    } catch (error) {
      this.fail(
        session,
        failureCode(error instanceof Error ? error : undefined),
      );

      return undefined;
    }
  }

  private async save(session: Session, credential: Credential) {
    try {
      const committed = await this.credentials.commitLogin(
        session.provider,
        credential,
        () => this.isCurrent(session),
        () => this.end(session, "succeeded"),
      );

      // Only the clock can reject a session that is still pending.
      if (!committed) this.end(session, "expired");
    } catch {
      this.fail(session, "storage_failure");
    }
  }

  private prompt(session: Session, prompt: AuthPrompt): Promise<string> {
    if (session.status !== "pending")
      return Promise.reject(new Error("Login ended"));

    if (session.prompt) {
      this.fail(session, "provider_failure");

      return Promise.reject(new Error("Overlapping login prompts"));
    }

    return this.awaitPrompt(session, prompt);
  }

  private awaitPrompt(session: Session, prompt: AuthPrompt): Promise<string> {
    const id = randomUUID();

    return new Promise<string>((resolve, reject) => {
      this.holdPrompt(session, id, prompt, resolve, reject);
    });
  }

  private holdPrompt(
    session: Session,
    id: string,
    prompt: AuthPrompt,
    resolve: (value: string) => void,
    reject: (error: Error) => void,
  ) {
    const signals = [session.controller.signal, prompt.signal];

    const release = () => {
      for (const signal of signals)
        signal?.removeEventListener("abort", withdraw);

      if (session.prompt?.prompt.id === id) session.prompt = null;
    };

    const withdraw = () => {
      release();
      reject(new Error("Prompt withdrawn"));
    };

    if (signals.some((signal) => signal?.aborted)) return withdraw();

    for (const signal of signals)
      signal?.addEventListener("abort", withdraw, { once: true });

    session.prompt = {
      prompt: promptView(id, prompt),
      settle: (value) => {
        release();
        resolve(value);
      },
    };
  }

  private notify(session: Session, event: AuthEvent) {
    if (session.status !== "pending") return;

    if (JSON.stringify(event).length > MAX_EVENT_BYTES)
      return this.fail(session, "provider_failure");

    this.appendEvent(session, copyEvent(event));
  }

  private appendEvent(session: Session, copy: LoginEvent) {
    const events = session.events;

    if (copy.type === "progress" && events.at(-1)?.type === "progress")
      events[events.length - 1] = copy;
    else events.push(copy);

    trimEvents(events);
  }

  private isCurrent(session: Session) {
    return (
      session.status === "pending" &&
      this.active.get(session.provider) === session &&
      !session.controller.signal.aborted &&
      Date.now() < this.expiresAt(session)
    );
  }

  private invalidate(providerId: string) {
    const session = this.active.get(providerId);

    if (session) this.end(session, "cancelled");
  }

  private fail(session: Session, code: Failure["code"]) {
    if (session.status !== "pending") return;
    session.failure = { code, message: FAILURES[code] };
    this.end(session, "failed");
  }

  /** Synchronous, so a commit guard that has passed cannot be overtaken by a cancellation. */
  private end(
    session: Session,
    status: Exclude<LoginSession["status"], "pending">,
  ) {
    if (session.status !== "pending") return;
    session.status = status;
    session.endedAt = Date.now();
    clearTimeout(session.timer);

    if (this.active.get(session.provider) === session)
      this.active.delete(session.provider);
    session.controller.abort(new Error("Login ended"));
    session.prompt = null;
    // Links and codes authorize only this attempt; keep them no longer than it runs.
    session.events = session.events.filter(
      (event) => event.type !== "auth_url" && event.type !== "device_code",
    );
  }

  private expiresAt(session: Session) {
    return Math.min(
      session.createdAt + LIFETIME_MS,
      session.lastActivity + INACTIVITY_MS,
    );
  }

  private schedule(session: Session) {
    clearTimeout(session.timer);
    session.timer = setTimeout(
      () => {
        if (Date.now() >= this.expiresAt(session)) this.end(session, "expired");
        else this.schedule(session);
      },
      Math.max(0, this.expiresAt(session) - Date.now()),
    );
  }

  private session(sessionId: string) {
    this.prune();
    const session = this.sessions.get(sessionId);

    if (!session) throw new Gone({ message: "This sign-in no longer exists" });

    return session;
  }

  private prune() {
    const ended = [...this.sessions.values()].filter(
      (session) => session.endedAt !== undefined,
    );

    const cutoff = Date.now() - RETAIN_ENDED_MS;

    ended.forEach((session, index) => {
      if (session.endedAt! < cutoff || ended.length - index > MAX_ENDED)
        this.sessions.delete(session.id);
    });
  }

  private project(session: Session): LoginSession {
    return {
      id: session.id,
      provider: session.provider,
      method: session.method,
      status: session.status,
      createdAt: session.createdAt,
      expiresAt: this.expiresAt(session),
      prompt: session.prompt ? structuredClone(session.prompt.prompt) : null,
      events: structuredClone(session.events),
      failure: session.failure && { ...session.failure },
    };
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);

    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/** Whether a login failed because the provider's callback port is already taken. */
export function isPortConflict(error: Error): boolean {
  return (
    selfPortConflict(error) ||
    (error.cause instanceof Error && isPortConflict(error.cause))
  );
}

function selfPortConflict(error: Error): boolean {
  return (
    ("code" in error && error.code === "EADDRINUSE") ||
    /\bport \d+ is in use\b/i.test(error.message)
  );
}

function failureCode(error: Error | undefined): Failure["code"] {
  return error && isPortConflict(error)
    ? "callback_unavailable"
    : "provider_failure";
}

function promptView(id: string, prompt: AuthPrompt): LoginPrompt {
  if (prompt.type === "select")
    return {
      id,
      type: "select",
      message: prompt.message,
      options: prompt.options.map(({ id, label, description }) => ({
        id,
        label,
        ...(description !== undefined && { description }),
      })),
    };

  return {
    id,
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder !== undefined && {
      placeholder: prompt.placeholder,
    }),
  };
}

function copyEvent(event: AuthEvent): LoginEvent {
  if (event.type !== "info") return { ...event };

  return {
    type: "info",
    message: event.message,
    ...(event.links && {
      links: event.links.map((link) => ({ ...link })),
    }),
  };
}

function trimEvents(events: LoginEvent[]) {
  // The current authorization link or device code outlives older messages.
  while (events.length > MAX_EVENTS) {
    const index = events.findIndex(
      (item) => item.type !== "auth_url" && item.type !== "device_code",
    );

    events.splice(index === -1 ? 0 : index, 1);
  }
}

/** Sign-ins over the credentials and settings `core` reaches, for an API that runs without an account. */
type StandaloneSignInServices =
  | ProviderCredentialRepository
  | ProviderCredentials
  | SettingsRepository
  | PasswordManagers
  | SecretValues;

export function standaloneSignIns(
  core: Runner<StandaloneSignInServices>,
  contributions?: readonly ProviderContribution[],
): ProviderSignInsAccess {
  const context = core.runSync(Effect.context<StandaloneSignInServices>());

  return providerSignInsAccess(
    ManagedRuntime.make(
      ProviderSignIns.layer.pipe(
        Layer.provide(ProviderModels.layer(contributions)),
        Layer.provide(Layer.succeedContext(context)),
      ),
    ),
  );
}
