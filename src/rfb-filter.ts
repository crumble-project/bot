/** A client message type the filter does not know: the connection must close, since its length is unknown. */
export class RfbProtocolError extends Error {}

// Handshake for RFB 3.8 with security None: version (12 bytes), security type (1), ClientInit (1).
const HANDSHAKE_BYTES = 14;

// KeyEvent, PointerEvent, ClientCutText, xvp (power operations), SetDesktopSize, QEMU extended key event.
const INPUT = new Set([4, 5, 6, 250, 251, 255]);

/** Length of the client message at the start of `bytes`; 0 when more bytes are needed to tell. */
function messageLength(bytes: Uint8Array): number {
  if (bytes.length < 1) return 0;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  switch (bytes[0]) {
    // SetPixelFormat
    case 0:
      return 20;

    // SetEncodings
    case 2:
      return bytes.length < 4 ? 0 : 4 + 4 * view.getUint16(2);

    // FramebufferUpdateRequest
    case 3:
      return 10;

    // KeyEvent
    case 4:
      return 8;

    // PointerEvent
    case 5:
      return 6;

    // ClientCutText. The extended clipboard (noVNC, TigerVNC) sends a negative length: the payload is its absolute value.
    case 6:
      return bytes.length < 8 ? 0 : 8 + Math.abs(view.getInt32(4));

    // EnableContinuousUpdates
    case 150:
      return 10;

    // ClientFence
    case 248:
      return bytes.length < 9 ? 0 : 9 + (bytes[8] ?? 0);

    // xvp
    case 250:
      return 4;

    // SetDesktopSize
    case 251:
      return bytes.length < 7 ? 0 : 8 + 16 * (bytes[6] ?? 0);

    // QEMU client message; only the extended key event is known.
    case 255:
      if (bytes.length < 2) return 0;

      if (bytes[1] === 0) return 12;

      throw new RfbProtocolError(`unknown QEMU client message ${bytes[1]}`);

    default:
      throw new RfbProtocolError(`unknown RFB client message ${bytes[0]}`);
  }
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
