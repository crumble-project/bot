import { expect, test } from "bun:test";
import { rfbFilter, RfbProtocolError } from "../src/rfb-filter";

const handshake = new Uint8Array([
  ...new TextEncoder().encode("RFB 003.008\n"),
  1,
  1,
]);

const pointer = new Uint8Array([5, 0, 0, 10, 0, 20]);
const key = new Uint8Array([4, 1, 0, 0, 0, 0, 0, 0x61]);
const update = new Uint8Array([3, 1, 0, 0, 0, 0, 5, 0, 3, 32]);
const qemuKey = new Uint8Array([255, 0, 0, 1, 0, 0, 0, 0x78, 0, 0, 0, 0x2d]);

const clipboardCaps = () => {
  const m = new Uint8Array(16);
  const view = new DataView(m.buffer);
  m[0] = 6;
  view.setInt32(4, -8);

  return m;
};

const concat = (...parts: Uint8Array[]) =>
  new Uint8Array(parts.flatMap((p) => [...p]));

test("the handshake passes, input is dropped unless allowed, and updates always pass", () => {
  let allowed = false;
  const filter = rfbFilter(() => allowed);

  expect(filter.push(handshake)).toEqual(handshake);
  expect(filter.push(concat(pointer, key, update))).toEqual(update);

  allowed = true;
  expect(filter.push(concat(pointer, key))).toEqual(concat(pointer, key));
});

test("noVNC's extended clipboard message has a negative length and does not stall the stream", () => {
  const filter = rfbFilter(() => false);
  filter.push(handshake);

  expect(filter.push(concat(clipboardCaps(), update))).toEqual(update);
});

test("QEMU extended key events are input", () => {
  let allowed = false;
  const filter = rfbFilter(() => allowed);
  filter.push(handshake);

  expect(filter.push(qemuKey)).toEqual(new Uint8Array());
  allowed = true;
  expect(filter.push(qemuKey)).toEqual(qemuKey);
});

test("messages split across chunks are reassembled", () => {
  const filter = rfbFilter(() => true);
  filter.push(handshake);

  expect(filter.push(update.subarray(0, 4))).toEqual(new Uint8Array());
  expect(filter.push(update.subarray(4))).toEqual(update);
});

test("an unknown message type is a protocol error", () => {
  const filter = rfbFilter(() => true);
  filter.push(handshake);

  expect(() => filter.push(new Uint8Array([99, 0, 0]))).toThrow(
    RfbProtocolError,
  );
});
