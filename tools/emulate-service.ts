import { createEmulator } from "emulate";
import { EMULATE_SEED } from "./emulate-scenarios.ts";

const emulator = await createEmulator({
  service: "ai",
  hostname: "127.0.0.1",
  port: 0,
  seed: EMULATE_SEED,
});

const url = new URL(emulator.url);

url.hostname = "127.0.0.1";

process.stdout.write(`${JSON.stringify({ type: "ready", url: url.origin })}\n`);

let closing = false;

const close = async () => {
  if (closing) {
    return;
  }

  closing = true;
  await emulator.close();
  process.exit(0);
};

process.once("SIGINT", () => void close());

process.once("SIGTERM", () => void close());
