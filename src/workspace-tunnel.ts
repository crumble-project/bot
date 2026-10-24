import net from "node:net";
import path from "node:path";
import type { MachineStream } from "./machine-workspaces";

/** The guest program; frames are described there. */
export const TUNNEL_SCRIPT = path.join(import.meta.dir, "workspace-tunnel.py");

/** Where guest programs reach the workspace proxy, as an HTTP CONNECT proxy. */
export const GUEST_PROXY_PORT = 3128;

const OPEN = 1;
const DATA = 2;
const END = 3;
const HEADER_BYTES = 9;

const frame = (kind: number, connection: number, payload?: Uint8Array) => {
  const header = Buffer.alloc(HEADER_BYTES);

  header.writeUInt8(kind, 0);
  header.writeUInt32BE(connection, 1);
  header.writeUInt32BE(payload?.length ?? 0, 5);

  return payload ? Buffer.concat([header, payload]) : header;
};

/**
 * Serves the guest end of `workspace-tunnel.py`: each connection a guest program opens to the tunnel's port becomes a
 * connection from `connect()`, here on the server. Ends when the stream does.
 */
export function serveTunnel(stream: MachineStream, connect: () => net.Socket) {
  const sockets = new Map<number, net.Socket>();
  // Writes to the guest are async; chaining keeps frames whole and in order.
  let writes = Promise.resolve();

  const write = (data: Buffer) => {
    writes = writes.then(() => stream.write(data)).catch(() => undefined);
  };

  const open = (connection: number) => {
    const socket = connect();
    let ended = false;

    const end = () => {
      if (ended) return;
      ended = true;
      write(frame(END, connection));
    };

    sockets.set(connection, socket);
    socket.on("data", (data: Buffer) => write(frame(DATA, connection, data)));
    socket.on("end", end);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      end();
      sockets.delete(connection);
    });
  };

  const receive = (kind: number, connection: number, payload: Buffer) => {
    if (kind === OPEN) return open(connection);

    const socket = sockets.get(connection);

    if (kind === DATA) socket?.write(payload);
    else if (kind === END) socket?.end();
  };

  const done = (async () => {
    let pending = Buffer.alloc(0);

    for await (const chunk of stream.output) {
      pending = Buffer.concat([pending, chunk]);

      while (pending.length >= HEADER_BYTES) {
        const length = pending.readUInt32BE(5);

        if (pending.length < HEADER_BYTES + length) break;
        receive(
          pending.readUInt8(0),
          pending.readUInt32BE(1),
          pending.subarray(HEADER_BYTES, HEADER_BYTES + length),
        );
        pending = pending.subarray(HEADER_BYTES + length);
      }
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      for (const socket of sockets.values()) socket.destroy();
    });

  return {
    done,
    async close() {
      try {
        await stream.end();
      } catch {
        // The stream may already be gone with its machine.
      }

      for (const socket of sockets.values()) socket.destroy();
    },
  };
}
