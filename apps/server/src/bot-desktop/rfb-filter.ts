export class RfbProtocolError extends Error {}

const HANDSHAKE_BYTES = 14;

const INPUT = new Set([4, 5, 6, 250, 251, 255]);

type Length = (bytes: Uint8Array, view: DataView) => number;

const FIXED_LENGTH = new Map([
  [0, 20],
  [3, 10],
  [4, 8],
  [5, 6],
  [150, 10],
  [250, 4],
]);

const COMPUTED_LENGTH = new Map<number, Length>([
  [2, (bytes, view) => (bytes.length < 4 ? 0 : 4 + 4 * view.getUint16(2))],
  [6, (bytes, view) => (bytes.length < 8 ? 0 : 8 + Math.abs(view.getInt32(4)))],
  [248, (bytes) => (bytes.length < 9 ? 0 : 9 + (bytes[8] ?? 0))],
  [251, (bytes) => (bytes.length < 7 ? 0 : 8 + 16 * (bytes[6] ?? 0))],
  [255, qemuLength],
]);

function qemuLength(bytes: Uint8Array): number {
  if (bytes.length < 2) {
    return 0;
  }

  if (bytes[1] === 0) {
    return 12;
  }

  throw new RfbProtocolError(`unknown QEMU client message ${bytes[1]}`);
}

function messageLength(bytes: Uint8Array): number {
  const type = bytes[0];

  if (type === undefined) {
    return 0;
  }

  const fixed = FIXED_LENGTH.get(type);

  if (fixed !== undefined) {
    return fixed;
  }

  const computed = COMPUTED_LENGTH.get(type);

  if (!computed) {
    throw new RfbProtocolError(`unknown RFB client message ${type}`);
  }

  return computed(
    bytes,
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  );
}

function concat(parts: Array<Uint8Array>) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

export function rfbFilter(allowInput: () => boolean) {
  let handshake = HANDSHAKE_BYTES;
  let buffer: Uint8Array = new Uint8Array();

  function passHandshake(out: Array<Uint8Array>) {
    if (handshake <= 0) {
      return;
    }
    const n = Math.min(handshake, buffer.length);

    out.push(buffer.subarray(0, n));
    buffer = buffer.subarray(n);
    handshake -= n;
  }

  return {
    push(chunk: Uint8Array): Uint8Array {
      buffer = buffer.length ? concat([buffer, chunk]) : chunk;

      const out: Array<Uint8Array> = [];
      passHandshake(out);

      while (handshake === 0 && buffer.length) {
        const length = messageLength(buffer);

        if (length === 0 || buffer.length < length) {
          break;
        }

        const message = buffer.subarray(0, length);

        buffer = buffer.subarray(length);

        if (INPUT.has(message[0] ?? -1) && !allowInput()) {
          continue;
        }

        out.push(message);
      }

      return concat(out);
    },
  };
}
