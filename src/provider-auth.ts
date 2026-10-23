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
} from "./api-responses";
import { AppError } from "./domain";
import type { ProviderCredentials } from "./provider-credentials";
import type { Store } from "./store";

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
 * Relays Pi AI login flows to clients. Sessions live in memory only: a restart ends them, while
 * saved credentials stay in the encrypted store. Raw provider errors never leave this module,
 * because Pi AI can put token responses into them.
 */
export class ProviderAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly active = new Map<string, Session>();
  private readonly flows = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly store: Store,
    private readonly credentials: ProviderCredentials,
    readonly models: Models,
  ) {}

  start(providerId: string, method: AuthType): LoginSession {
    if (this.closed) throw new AppError(503, "The server is shutting down");
    const provider = this.models.getProvider(providerId);

    if (!provider) throw new AppError(404, "Unknown provider");
    const login = this.loginFunction(provider, method);

    if (!login)
      throw new AppError(400, `${provider.name} does not offer this sign-in`);

    if (this.active.has(providerId))
      throw new AppError(409, "A sign-in for this provider is in progress");

    if (this.active.size >= MAX_ACTIVE)
      throw new AppError(409, "Too many sign-ins are in progress");
    this.prune();
    const now = Date.now();

    const session: Session = {
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

    this.sessions.set(session.id, session);
    this.active.set(providerId, session);
    this.schedule(session);
    const hint = method === "oauth" ? REMOTE_HINTS.get(providerId) : undefined;

    if (hint) session.events.push({ type: "info", message: hint });
    const flow = this.run(session, login);
    this.flows.add(flow);
    void flow.finally(() => this.flows.delete(flow));

    return this.project(session);
  }

  get(sessionId: string): LoginSession {
    return this.project(this.session(sessionId));
  }

  answer(sessionId: string, promptId: string, value: string): LoginSession {
    const session = this.session(sessionId);

    if (session.status !== "pending")
      throw new AppError(409, "This sign-in has ended");
    const pending = session.prompt;

    if (!pending || pending.prompt.id !== promptId)
      throw new AppError(409, "This prompt no longer accepts an answer");

    if (
      pending.prompt.type === "select" &&
      !pending.prompt.options?.some((option) => option.id === value)
    )
      throw new AppError(400, "Choose one of the offered options");
    session.lastActivity = Date.now();
    this.schedule(session);
    pending.settle(value);

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
    const { signal } = session.controller;
    let credential: Credential;

    try {
      credential = await abortable(
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
        error instanceof Error && isPortConflict(error)
          ? "callback_unavailable"
          : "provider_failure",
      );

      return;
    }

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

    return new Promise((resolve, reject) => {
      const id = randomUUID();
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
        prompt:
          prompt.type === "select"
            ? {
                id,
                type: "select",
                message: prompt.message,
                options: prompt.options.map(({ id, label, description }) => ({
                  id,
                  label,
                  ...(description !== undefined && { description }),
                })),
              }
            : {
                id,
                type: prompt.type,
                message: prompt.message,
                ...(prompt.placeholder !== undefined && {
                  placeholder: prompt.placeholder,
                }),
              },
        settle: (value) => {
          release();
          resolve(value);
        },
      };
    });
  }

  private notify(session: Session, event: AuthEvent) {
    if (session.status !== "pending") return;

    if (JSON.stringify(event).length > MAX_EVENT_BYTES)
      return this.fail(session, "provider_failure");

    const copy: LoginEvent =
      event.type === "info"
        ? {
            type: "info",
            message: event.message,
            ...(event.links && {
              links: event.links.map((link) => ({ ...link })),
            }),
          }
        : { ...event };

    const events = session.events;

    if (copy.type === "progress" && events.at(-1)?.type === "progress")
      events[events.length - 1] = copy;
    else events.push(copy);

    // The current authorization link or device code outlives older messages.
    while (events.length > MAX_EVENTS) {
      const index = events.findIndex(
        (item) => item.type !== "auth_url" && item.type !== "device_code",
      );

      events.splice(index === -1 ? 0 : index, 1);
    }
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

    if (!session) throw new AppError(410, "This sign-in no longer exists");

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

  private deviceId() {
    const saved = this.store.getSetting<string>(DEVICE_ID);

    if (saved) return saved;

    return this.store.setSetting(DEVICE_ID, randomUUID());
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

function isPortConflict(error: Error): boolean {
  if (
    ("code" in error && error.code === "EADDRINUSE") ||
    /\bport \d+ is in use\b/i.test(error.message)
  )
    return true;

  return error.cause instanceof Error && isPortConflict(error.cause);
}
