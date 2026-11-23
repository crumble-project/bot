import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

const readiness = z.object({ type: z.literal("ready"), url: z.url() });
const missingProcess = z.object({ code: z.literal("ESRCH") });

export const REPOSITORY_DIR = fileURLToPath(new URL("../", import.meta.url));

export function localEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "TERM",
      "SystemRoot",
    ].flatMap((key) => (env[key] === undefined ? [] : [[key, env[key]]])),
  );
}

export type LocalProcess = {
  url: string;
  exited: Promise<number | null>;
  close(): Promise<void>;
};

async function startProcess(
  command: string,
  args: Array<string>,
): Promise<LocalProcess> {
  const child = spawn(command, args, {
    cwd: REPOSITORY_DIR,
    env: localEnvironment(process.env),
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ready = Promise.withResolvers<string>();
  const exit = Promise.withResolvers<number | null>();
  const lines = createInterface({ input: child.stdout });
  child.stderr.pipe(process.stderr, { end: false });

  const timeout = setTimeout(
    () =>
      ready.reject(
        new Error("Local service startup timed out after 10 seconds"),
      ),
    10_000,
  );

  child.once("error", (error) => {
    ready.reject(error);
    exit.resolve(null);
  });
  child.once("exit", (code, signal) => {
    ready.reject(
      new Error(`Local service exited before readiness (${code ?? signal})`),
    );
    exit.resolve(code);
  });
  lines.on("line", (line: string) => {
    try {
      const record = readiness.safeParse(JSON.parse(line));

      if (!record.success) {
        process.stderr.write(`${line}\n`);

        return;
      }

      const url = new URL(record.data.url);

      if (
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        !url.port ||
        url.username ||
        url.password
      ) {
        throw new Error("Local service returned a non-loopback address");
      }

      ready.resolve(url.origin);
    } catch {
      process.stderr.write(`${line}\n`);
    }
  });
  let closing: Promise<void> | undefined;

  const signal = (value: NodeJS.Signals | 0) => {
    if (!child.pid) {
      return;
    }

    try {
      if (process.platform === "win32") {
        child.kill(value);
      } else {
        process.kill(-child.pid, value);
      }
    } catch (error) {
      if (!missingProcess.safeParse(error).success) {
        throw error;
      }
    }
  };

  const close = () =>
    (closing ??= (async () => {
      const deadline = Date.now() + 5000;
      signal("SIGTERM");
      let killTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          exit.promise,
          new Promise<void>((resolve) => {
            killTimer = setTimeout(() => {
              signal("SIGKILL");
              resolve();
            }, 5000);
          }),
        ]);
        await exit.promise;

        if (process.platform !== "win32" && child.pid) {
          const pid = child.pid;

          const groupExists = () => {
            try {
              process.kill(-pid, 0);

              return true;
            } catch (error) {
              if (!missingProcess.safeParse(error).success) {
                throw error;
              }

              return false;
            }
          };

          while (groupExists() && Date.now() < deadline) {
            await delay(25);
          }

          if (groupExists()) {
            signal("SIGKILL");
          }
        }
      } finally {
        clearTimeout(killTimer);
        lines.close();
      }
    })());

  try {
    return { url: await ready.promise, exited: exit.promise, close };
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function startEmulate(): Promise<LocalProcess> {
  const version = spawnSync("node", ["--version"], {
    env: localEnvironment(process.env),
    encoding: "utf8",
    timeout: 3000,
  });

  if (
    version.error ||
    version.status !== 0 ||
    Number(/^v(\d+)/.exec(version.stdout)?.[1] ?? 0) < 24
  ) {
    throw new Error(
      "Emulate needs Node 24 or later on PATH. Install Node, then run this command again.",
    );
  }

  return startProcess("node", [
    "--experimental-strip-types",
    "tools/emulate-service.ts",
  ]);
}

export function startLocalApp(options: {
  baseUrl: string;
  dataDir: string;
  port: number;
  watch?: boolean;
}): Promise<LocalProcess> {
  const { watch, ...profile } = options;

  return startProcess(process.execPath, [
    "--no-env-file",
    ...(watch ? ["--watch", "--watch-kill-signal=SIGTERM"] : []),
    "tools/emulate-server.ts",
    JSON.stringify(profile),
  ]);
}
