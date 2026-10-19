import net from "node:net";

// Spawned by pi-env's Connection as `<runtime> workspace-bridge.ts <socket> serve --token <hex>`: it carries the
// protocol on stdio to the relay, which runs the daemon inside the guest. Only the process that owns a sandbox runs
// commands in it.
const [socketPath, ...daemonArgs] = process.argv.slice(2);
const socket = net.connect(socketPath ?? "");

socket.on("connect", () => {
  socket.write(`${JSON.stringify(daemonArgs)}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});

socket.on("close", () => process.exit(0));

socket.on("error", (error) => {
  console.error(`workspace bridge: ${error.message}`);
  process.exit(1);
});
