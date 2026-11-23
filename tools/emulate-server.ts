import { z } from "zod";
import { startServer } from "../apps/server/src/app/server";

const options = z
  .object({
    baseUrl: z.string(),
    dataDir: z.string().min(1),
    port: z.number().int().min(0).max(65_535),
  })
  .parse(JSON.parse(process.argv[2] ?? "{}"));

const running = await startServer({
  dataDir: options.dataDir,
  hostname: "127.0.0.1",
  port: options.port,
  workspaceEnv: {},
  emulate: { baseUrl: options.baseUrl },
});

process.stdout.write(
  `${JSON.stringify({ type: "ready", url: running.server.url.origin })}\n`,
);

let closing = false;

const close = async () => {
  if (closing) {
    return;
  }

  closing = true;
  await running.close();
  process.exit(0);
};

process.once("SIGINT", () => void close());

process.once("SIGTERM", () => void close());
