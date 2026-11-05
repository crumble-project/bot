import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Redacted } from "effect";
import { secretKey } from "../secrets/secret-key";
import { Secrets } from "../secrets/secrets";
import type { SecretInput } from "../shared/domain";
import { runnerOf, type Runner } from "../shared/runner";
import { ProviderCredentialRepository } from "./provider-credential-repository";

/** The secret holding a provider's API key. */
export const providerApiKeyKey = (providerId: string) =>
  secretKey("provider", providerId);

/** Pi AI's credential store, with what sign-in flows need beyond it. */
export type ProviderCredentialStore = CredentialStore & {
  commitLogin: QueuedCredentialStore["commitLogin"];
  setApiKey: QueuedCredentialStore["setApiKey"];
  idle: QueuedCredentialStore["idle"];
  status: QueuedCredentialStore["status"];
};

type Services = ProviderCredentialRepository | Secrets;

/**
 * Pi AI's credential store over the account's encrypted provider credentials, with each API key kept as a secret.
 * One instance serves the API and every bot runtime; the data-directory lock makes this process the only writer, so
 * per-provider promise queues serialize refresh, login, key replacement and sign-out.
 */
export class ProviderCredentials extends Context.Service<
  ProviderCredentials,
  ProviderCredentialStore
>()("crumble/providers/ProviderCredentials") {
  static readonly layer = Layer.effect(
    ProviderCredentials,
    Effect.gen(function* () {
      return new QueuedCredentialStore(
        runnerOf(yield* Effect.context<Services>()),
      );
    }),
  );
}

class QueuedCredentialStore implements CredentialStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly run: Runner<Services>) {}

  private repository<A>(
    use: (
      repository: ProviderCredentialRepository["Service"],
    ) => Effect.Effect<A>,
  ) {
    return this.run.runSync(ProviderCredentialRepository.use(use));
  }

  /** Saves a credential synchronously, an API key's `key` as its secret. */
  private write(providerId: string, credential: Credential) {
    const apiKey = providerApiKeyKey(providerId);

    if (credential.type === "api_key") {
      const { key, ...rest } = credential;

      if (key !== undefined)
        this.run.runSync(
          Secrets.use((s) => s.save(apiKey, { value: key })).pipe(Effect.orDie),
        );
      this.repository((r) => r.set(providerId, rest));
    } else {
      this.repository((r) => r.set(providerId, credential));
      this.run.runSync(Secrets.use((s) => s.delete(apiKey)));
    }
  }

  /** The saved credential, without an API key's `key`. */
  private stored(providerId: string) {
    return this.repository((r) => r.get(providerId));
  }

  /** The provider's credential, its API key read from the secret, possibly a password manager. */
  private async resolve(providerId: string): Promise<Credential | undefined> {
    const credential = this.stored(providerId);

    if (credential?.type !== "api_key") return credential;

    const key = await this.run.runPromise(
      Secrets.use((s) => s.read(providerApiKeyKey(providerId))).pipe(
        Effect.mapError(
          (error) =>
            // Pi AI puts this after "Credential store read failed for <provider>: ", which names the provider.
            new Error(`API key could not be read: ${error.message}`),
        ),
      ),
    );

    return key ? { ...credential, key: Redacted.value(key) } : credential;
  }

  /** How the provider is signed in, for the owner's list: never a credential's value. */
  status(providerId: string) {
    return {
      credentialType:
        this.repository((r) => r.list).find(
          (info) => info.providerId === providerId,
        )?.type ?? null,
      apiKey: this.run.runSync(
        Secrets.use((s) => s.status(providerApiKeyKey(providerId))),
      ),
    };
  }

  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();

    return this.resolve(providerId);
  }

  async list(
    options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();

    return this.repository((r) => r.list);
  }

  modify(
    providerId: string,
    update: (
      current: Credential | undefined,
    ) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ) {
    return this.enqueue(
      providerId,
      async () => {
        // Only OAuth refresh reads the current credential, so modify reads no API key.
        const next = await update(this.stored(providerId));

        // A started refresh persists even if its caller went away, so a rotated token is never lost.
        if (next !== undefined) this.write(providerId, next);

        return this.stored(providerId);
      },
      options?.signal,
    );
  }

  async delete(providerId: string, options?: AuthOperationOptions) {
    await this.enqueue(
      providerId,
      async () => {
        this.repository((r) => r.delete(providerId));
        this.run.runSync(
          Secrets.use((s) => s.delete(providerApiKeyKey(providerId))),
        );
      },
      options?.signal,
    );
  }

  /**
   * Persists a completed login only if it is still current when its turn comes. The guard, write
   * and state transition run synchronously together, so no cancellation can slip between them.
   */
  commitLogin(
    providerId: string,
    credential: Credential,
    isCurrent: () => boolean,
    onCommitted: () => void,
  ) {
    return this.enqueue(providerId, async () => {
      if (!isCurrent()) return false;
      this.write(providerId, credential);
      onCommitted();

      return true;
    });
  }

  /** Replaces the credential with an API key, stored or read from a password manager; fails on an unreadable reference. */
  setApiKey(providerId: string, key: SecretInput) {
    return this.enqueue(providerId, async () => {
      await this.run.runPromise(
        Secrets.use((s) => s.save(providerApiKeyKey(providerId), key)),
      );
      this.repository((r) => r.set(providerId, { type: "api_key" }));
    });
  }

  /** Resolves once every queued mutation has settled. */
  async idle() {
    await Promise.all(this.queues.values());
  }

  private enqueue<T>(
    providerId: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.queues.get(providerId) ?? Promise.resolve();
    let started = false;

    const run = previous.then(() => {
      if (signal?.aborted) throw signal.reason;
      started = true;

      return task();
    });

    const tail = run.catch(() => {});
    this.queues.set(providerId, tail);
    void tail.then(() => {
      if (this.queues.get(providerId) === tail) this.queues.delete(providerId);
    });

    if (!signal) return run;

    // Waiting callers honor cancellation; a started task keeps the queue until it settles.
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        if (!started) reject(signal.reason);
      };

      signal.addEventListener("abort", onAbort, { once: true });
      run.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
  }
}
