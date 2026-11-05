import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { rm } from "node:fs/promises";
import { join } from "node:path";

type Storage = Awaited<ReturnType<typeof openNodeSqliteStorage>>;

/** One Pi store per key in `dir`: each opens once, and a failed open leaves nothing behind. */
export class HarnessFiles<Opened extends { harness: Harness }> {
  private readonly opened = new Map<string, Promise<Opened>>();
  private closed = false;

  constructor(
    private readonly dir: string,
    private readonly closedMessage: string,
  ) {}

  private path(key: string) {
    return join(this.dir, `${key}.sqlite`);
  }

  private async openFile(
    key: string,
    open: (storage: Storage) => Promise<Opened>,
  ) {
    const storage = await openNodeSqliteStorage(this.path(key));

    try {
      return await open(storage);
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
  }

  async get(key: string, open: (storage: Storage) => Promise<Opened>) {
    if (this.closed) throw new Error(this.closedMessage);
    const existing = this.opened.get(key);

    if (existing) return existing;
    const opening = this.openFile(key, open);
    this.opened.set(key, opening);

    try {
      return await opening;
    } catch (error) {
      this.opened.delete(key);
      throw error;
    }
  }

  /** Closes the store if it is open and removes its files. */
  async delete(key: string) {
    const pending = this.opened.get(key);
    this.opened.delete(key);

    if (pending) await (await pending).harness.close(BACKGROUND_CONTEXT);

    for (const suffix of ["", "-wal", "-shm"])
      await rm(`${this.path(key)}${suffix}`, { force: true });
  }

  async close() {
    this.closed = true;
    const opened = await Promise.allSettled(this.opened.values());
    await Promise.all(
      opened
        .filter((each) => each.status === "fulfilled")
        .map((each) => each.value.harness.close(BACKGROUND_CONTEXT)),
    );
    this.opened.clear();
  }
}
