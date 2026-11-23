import { resolve } from "node:path";
import { EMULATE_MODEL_IDS } from "../apps/server/src/providers/emulate-profile";
import { REPOSITORY_DIR, startEmulate, startLocalApp } from "./emulate-process";
import type { LocalProcess } from "./emulate-process";

const pending: Array<Promise<LocalProcess>> = [];
const interrupted = Promise.withResolvers<void>();
let stopping = false;
let closing: Promise<void> | undefined;

const close = () =>
  (closing ??= (async () => {
    const settled = await Promise.allSettled(pending);
    await Promise.all(
      settled.flatMap((item) =>
        item.status === "fulfilled" ? [item.value.close()] : [],
      ),
    );
  })());

const stop = () => {
  stopping = true;
  interrupted.resolve();
};

process.once("SIGINT", stop);

process.once("SIGTERM", stop);

try {
  const emulatorStarting = startEmulate();
  pending.push(emulatorStarting);
  const emulator = await emulatorStarting;

  if (!stopping) {
    const dataDir = resolve(REPOSITORY_DIR, ".cache/emulate/data");

    const appStarting = startLocalApp({
      baseUrl: `${emulator.url}/v1`,
      dataDir,
      port: 7338,
      watch: true,
    });

    pending.push(appStarting);
    const app = await appStarting;

    if (!stopping) {
      process.stdout.write(`Crumble: ${app.url}\n`);
      process.stdout.write(`Emulate: ${emulator.url}\n`);
      process.stdout.write(`Local data: ${dataDir}\n`);
      process.stdout.write(`Scenarios: ${EMULATE_MODEL_IDS.join(", ")}\n`);
      process.stdout.write(
        "Create a local account, then choose Emulate (local) when creating a bot. Ctrl+C stops both services.\n",
      );
      await Promise.race([
        interrupted.promise,
        app.exited.then(() => {
          throw new Error("The local Crumble process exited");
        }),
        emulator.exited.then(() => {
          throw new Error("The AI emulator exited");
        }),
      ]);
    }
  }
} finally {
  await close();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
}
