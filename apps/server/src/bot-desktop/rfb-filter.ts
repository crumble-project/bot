/** A client message type the filter does not know: the connection must close, since its length is unknown. */
export class RfbProtocolError extends Error {}

// Handshake for RFB 3.8 with security None: version (12 bytes), security type (1), ClientInit (1).
const HANDSHAKE_BYTES = 14;

// KeyEvent, PointerEvent, ClientCutText, xvp (power operations), SetDesktopSize, QEMU extended key event.
const INPUT = new Set([4, 5, 6, 250, 251, 255]);

type Length = (bytes: Uint8Array, view: DataView) => number;

/** Message types whose length is fixed; the number is the message's size in bytes. */
const FIXED_LENGTH = new Map([
  [0, 20], // SetPixelFormat
  [3, 10], // FramebufferUpdateRequest
  [4, 8], // KeyEvent
  [5, 6], // PointerEvent
  [150, 10], // EnableContinuousUpdates
  [250, 4], // xvp
]);

/** Message types whose length comes from their own header; 0 until enough bytes are buffered. */
const COMPUTED_LENGTH = new Map<number, Length>([
  [2, (bytes, view) => (bytes.length < 4 ? 0 : 4 + 4 * view.getUint16(2))], // SetEncodings
  // The extended clipboard (noVNC, TigerVNC) sends a negative length: the payload is its absolute value.
  [6, (bytes, view) => (bytes.length < 8 ? 0 : 8 + Math.abs(view.getInt32(4)))],
  [248, (bytes) => (bytes.length < 9 ? 0 : 9 + (bytes[8] ?? 0))], // ClientFence
  [251, (bytes) => (bytes.length < 7 ? 0 : 8 + 16 * (bytes[6] ?? 0))], // SetDesktopSize
  [255, qemuLength],
]);

/** A QEMU client message; only the extended key event is known. */
function qemuLength(bytes: Uint8Array): number {
  if (bytes.length < 2) return 0;

  if (bytes[1] === 0) return 12;

  throw new RfbProtocolError(`unknown QEMU client message ${bytes[1]}`);
}

/** Length of the client message at the start of `bytes`; 0 when more bytes are needed to tell. */
function messageLength(bytes: Uint8Array): number {
  const type = bytes[0];

  if (type === undefined) return 0;

  const fixed = FIXED_LENGTH.get(type);

  if (fixed !== undefined) return fixed;

  const computed = COMPUTED_LENGTH.get(type);

  if (!computed)
    throw new RfbProtocolError(`unknown RFB client message ${type}`);

  return computed(
    bytes,
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  );
}

function concat(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/**
 * Filters a viewer's client-to-server RFB stream: input passes only while `allowInput()` is true, everything else
 * passes. Watching thereby never lets input through; the bot desktop's control lease decides.
 */
export function rfbFilter(allowInput: () => boolean) {
  let handshake = HANDSHAKE_BYTES;
  let buffer: Uint8Array = new Uint8Array();
  const stats = { passed: 0, dropped: 0 };

  return {
    stats,
    push(chunk: Uint8Array): Uint8Array {
      buffer = buffer.length ? concat([buffer, chunk]) : chunk;

      const out: Uint8Array[] = [];

      if (handshake > 0) {
        const n = Math.min(handshake, buffer.length);

        out.push(buffer.subarray(0, n));
        buffer = buffer.subarray(n);
        handshake -= n;
      }

      while (handshake === 0 && buffer.length) {
        const length = messageLength(buffer);

        if (length === 0 || buffer.length < length) break;

        const message = buffer.subarray(0, length);

        buffer = buffer.subarray(length);

        if (INPUT.has(message[0] ?? -1) && !allowInput()) {
          stats.dropped += 1;

          continue;
        }

        stats.passed += 1;
        out.push(message);
      }

      return concat(out);
    },
  };
}
