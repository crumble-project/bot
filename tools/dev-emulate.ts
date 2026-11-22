import { resolve } from "node:path";
import { EMULATE_MODEL_IDS } from "../apps/server/src/providers/emulate-profile";
import {
  REPOSITORY_DIR,
  startEmulate,
  startLocalApp,
  type LocalProcess,
} from "./emulate-process";

const pending: Promise<LocalProcess>[] = [];
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
      console.log(`Crumble: ${app.url}`);
      console.log(`Emulate: ${emulator.url}`);
      console.log(`Local data: ${dataDir}`);
      console.log(`Scenarios: ${EMULATE_MODEL_IDS.join(", ")}`);
      console.log(
        "Create a local account, then choose Emulate (local) when creating a bot. Ctrl+C stops both services.",
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
