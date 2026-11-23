import net from "node:net";
import { logError } from "../shared/process-log";

const [socketPath, ...daemonArgs] = process.argv.slice(2);
const socket = net.connect(socketPath ?? "");

socket.on("connect", () => {
  socket.write(`${JSON.stringify(daemonArgs)}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("close", () => process.exit(0));

socket.on("error", (error) => {
  logError(`workspace bridge: ${error.message}`);
  process.exit(1);
});
