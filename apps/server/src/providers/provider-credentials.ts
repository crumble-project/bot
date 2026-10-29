import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Redacted } from "effect";
import { SecretValues } from "../password-managers/secret-values";
import { runnerOf, type Runner } from "../shared/runner";
import { ProviderCredentialRepository } from "./provider-credential-repository";

/** Pi AI's credential store, with what sign-in flows need beyond it. */
export type ProviderCredentialStore = CredentialStore & {
  commitLogin: QueuedCredentialStore["commitLogin"];
  idle: QueuedCredentialStore["idle"];
};

/**
 * Pi AI's credential store over the account's encrypted provider credentials. One instance serves the API and every
 * bot runtime; the data-directory lock makes this process the only writer, so per-provider promise queues serialize
 * refresh, login, key replacement and sign-out.
 */
export class ProviderCredentials extends Context.Service<
  ProviderCredentials,
  ProviderCredentialStore
>()("crumble/providers/ProviderCredentials") {
  static readonly layer = Layer.effect(
    ProviderCredentials,
    Effect.gen(function* () {
      const run = runnerOf(
        yield* Effect.context<ProviderCredentialRepository | SecretValues>(),
      );

      return new QueuedCredentialStore(run);
    }),
  );
}

class QueuedCredentialStore implements CredentialStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly run: Runner<ProviderCredentialRepository | SecretValues>,
  ) {}

  private repository<A>(
    use: (
      repository: ProviderCredentialRepository["Service"],
    ) => Effect.Effect<A>,
  ) {
    return this.run.runSync(ProviderCredentialRepository.use(use));
  }

  /** The credential stored in Crumble; a password manager reference has none. */
  private stored(providerId: string) {
    const source = this.repository((r) => r.get(providerId));

    return source && "credential" in source ? source.credential : undefined;
  }

  /** The provider's credential, reading an API key from its password manager when it is a reference. */
  private async resolve(providerId: string): Promise<Credential | undefined> {
    const source = this.repository((r) => r.get(providerId));

    if (!source) return undefined;

    if ("credential" in source) return source.credential;

    const key = await this.run.runPromise(
      SecretValues.use((values) => values.read(source)).pipe(
        Effect.map(Redacted.value),
        Effect.mapError(
          (error) =>
            // Pi AI puts this after "Credential store read failed for <provider>: ", which names the provider.
            new Error(`API key could not be read: ${error.message}`),
        ),
      ),
    );

    return { type: "api_key", key };
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
        // Only OAuth refresh reads the current credential, and a reference is never OAuth, so modify reads no password manager.
        const next = await update(this.stored(providerId));

        // A started refresh persists even if its caller went away, so a rotated token is never lost.
        if (next !== undefined) this.repository((r) => r.set(providerId, next));

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
      this.repository((r) => r.set(providerId, credential));
      onCommitted();

      return true;
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
