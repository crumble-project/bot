import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";

const STALE_MS = 30_000;
const UPDATE_MS = 10_000;

/** Data directories this process holds, so a second server in the same process is refused. */
const held = new Set<string>();

export class DataDirLocked extends Error {
  constructor(dataDir: string, owner: number | undefined) {
    super(
      `Another Crumble server${owner ? ` (pid ${owner})` : ""} is using ${dataDir}. ` +
        "Stop it, or set CRUMBLE_DATA_DIR to a different directory.",
    );
    this.name = "DataDirLocked";
  }
}

const codeOf = (error: Error) => ("code" in error ? error.code : undefined);

const ownerFile = (dataDir: string) => join(dataDir, "server.pid");

function readOwner(dataDir: string) {
  try {
    const pid = Number(readFileSync(ownerFile(dataDir), "utf8").trim());

    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Whether another live process has this pid; our own pid is a previous run replaced by a watch restart. */
function othersAlive(pid: number) {
  if (pid === process.pid) return false;

  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && codeOf(error) === "EPERM";
  }
}

/**
 * Takes the data directory for this server and returns how to release it.
 * A lock whose recorded owner has exited, or is this process before a watch restart, is
 * taken over at once; one held by a live server fails at once; one without a recorded
 * owner is waited out until it goes stale.
 */
export async function lockDataDir(dataDir: string, waitMs = 35_000) {
  const path = resolve(dataDir);

  if (held.has(path)) throw new DataDirLocked(path, process.pid);

  const owner = readOwner(path);
  const ownerAlive = owner !== undefined && othersAlive(owner);

  if (owner !== undefined && !ownerAlive)
    rmSync(`${path}.lock`, { recursive: true, force: true });

  let released = false;
  let release: () => Promise<void>;

  const acquire = (retries: number) =>
    lockfile.lock(path, {
      stale: STALE_MS,
      update: UPDATE_MS,
      retries: { retries, factor: 1, minTimeout: 1000 },
      // The lock directory vanished or another process took it; take it back instead of throwing.
      onCompromised: (error) => {
        if (released) return;

        console.warn(
          `Lost the lock on ${path} (${error.message}); taking it back.`,
        );
        acquire(0).then(
          (next) => {
            release = next;
            writeFileSync(ownerFile(path), `${process.pid}\n`);
          },
          () => {
            console.error(new DataDirLocked(path, readOwner(path)).message);
            process.exit(1);
          },
        );
      },
    });

  try {
    release = await acquire(ownerAlive ? 0 : Math.ceil(waitMs / 1000));
  } catch (error) {
    if (error instanceof Error && codeOf(error) === "ELOCKED")
      throw new DataDirLocked(path, readOwner(path));

    throw error;
  }

  held.add(path);
  writeFileSync(ownerFile(path), `${process.pid}\n`);

  return async () => {
    if (released) return;

    released = true;
    held.delete(path);

    if (readOwner(path) === process.pid)
      rmSync(ownerFile(path), { force: true });

    await release();
  };
}
