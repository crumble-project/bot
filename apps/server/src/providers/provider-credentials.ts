import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import type { Store } from "../shared/store";

/**
 * Pi AI's credential store over the encrypted Store. One instance serves the API and every bot
 * runtime; the data-directory lock makes this process the only writer, so per-provider promise
 * queues serialize refresh, login, key replacement and sign-out.
 */
export class ProviderCredentials implements CredentialStore {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly store: Store) {}

  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted();

    return this.store.getProviderCredential(providerId);
  }

  async list(
    options?: AuthOperationOptions,
  ): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();

    return this.store.listProviderCredentials();
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
        const next = await update(this.store.getProviderCredential(providerId));

        // A started refresh persists even if its caller went away, so a rotated token is never lost.
        if (next !== undefined)
          this.store.setProviderCredential(providerId, next);

        return this.store.getProviderCredential(providerId);
      },
      options?.signal,
    );
  }

  async delete(providerId: string, options?: AuthOperationOptions) {
    await this.enqueue(
      providerId,
      async () => {
        this.store.deleteProviderCredential(providerId);
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
      this.store.setProviderCredential(providerId, credential);
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
