import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

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

const HOST = hostname();

const ownerFile = (dataDir: string) => join(dataDir, "server.pid");

export const ownerRecord = (pid: number) => `${pid}\n${HOST}\n`;

function readOwner(dataDir: string) {
  try {
    const [line, host] = readFileSync(ownerFile(dataDir), "utf8").split("\n");
    const pid = Number(line?.trim());

    return Number.isInteger(pid) && pid > 0
      ? { pid, host: host?.trim() }
      : undefined;
  } catch {
    return;
  }
}

/** Whether another live process on this host has the pid; our own pid is a run replaced by a watch restart. */
function othersAlive(owner: { pid: number; host: string | undefined }) {
  if (owner.host !== HOST || owner.pid === process.pid) return false;

  try {
    process.kill(owner.pid, 0);

    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export async function lockDataDir(dataDir: string) {
  const path = resolve(dataDir);

  if (held.has(path)) throw new DataDirLocked(path, process.pid);

  const owner = readOwner(path);

  if (owner && othersAlive(owner)) throw new DataDirLocked(path, owner.pid);

  writeFileSync(ownerFile(path), ownerRecord(process.pid));
  held.add(path);

  let released = false;

  return async () => {
    if (released) return;

    released = true;
    held.delete(path);

    if (readOwner(path)?.pid === process.pid)
      rmSync(ownerFile(path), { force: true });
  };
}
