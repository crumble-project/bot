/**
 * A minimal RFB 3.8 viewer over a WebSocket, sending the same messages noVNC sends: the extended clipboard's negative
 * length, QEMU extended key events, pointer events, and framebuffer update requests.
 */
export async function connectRfb(url: string) {
  const ws = new WebSocket(url);

  ws.binaryType = "arraybuffer";

  let buffer = new Uint8Array();
  let wake: (() => void) | undefined;
  let closed = false;

  ws.addEventListener("message", (event) => {
    if (!(event.data instanceof ArrayBuffer)) return;

    const next = new Uint8Array(buffer.length + event.data.byteLength);

    next.set(buffer);
    next.set(new Uint8Array(event.data), buffer.length);
    buffer = next;
    wake?.();
  });

  const ended = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => {
      closed = true;
      wake?.();
      resolve(event.code);
    }),
  );

  const read = async (n: number) => {
    while (buffer.length < n) {
      if (closed) throw new Error("The viewer connection closed");

      await new Promise<void>((resolve) => (wake = resolve));
    }

    const out = buffer.slice(0, n);

    buffer = buffer.slice(n);

    return out;
  };

  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WebSocket error")));
  });

  const version = new TextDecoder().decode(await read(12));

  ws.send(new TextEncoder().encode("RFB 003.008\n"));

  const types = (await read(1))[0] ?? 0;

  await read(types);
  ws.send(new Uint8Array([1]));
  await read(4);
  ws.send(new Uint8Array([1]));

  const init = await read(24);
  const view = new DataView(init.buffer);

  await read(view.getUint32(20));

  const width = view.getUint16(0);
  const height = view.getUint16(2);

  // Raw encoding only, so updates are easy to skip.
  ws.send(new Uint8Array([2, 0, 0, 1, 0, 0, 0, 0]));

  const send = (bytes: number[] | Uint8Array) => ws.send(new Uint8Array(bytes));

  return {
    version,
    width,
    height,
    ended,
    pointer(x: number, y: number, mask = 0) {
      send([5, mask, x >> 8, x & 255, y >> 8, y & 255]);
    },
    click(x: number, y: number) {
      this.pointer(x, y);
      this.pointer(x, y, 1);
      this.pointer(x, y, 0);
    },
    /** A key press and release as noVNC sends them: a QEMU extended key event with the XT scan code. */
    key(keysym: number, scancode: number) {
      for (const down of [1, 0]) {
        const message = new Uint8Array(12);
        const fields = new DataView(message.buffer);

        message[0] = 255;
        fields.setUint16(2, down);
        fields.setUint32(4, keysym);
        fields.setUint32(8, scancode);
        send(message);
      }
    },
    clipboardCaps() {
      const message = new Uint8Array(16);
      const fields = new DataView(message.buffer);

      message[0] = 6;
      fields.setInt32(4, -8);
      fields.setUint32(8, 1);
      fields.setUint32(12, 1024);
      send(message);
    },
    /** Requests a 10x10 update and reads it; false when none arrives within 5 s. */
    async smallUpdate() {
      send([3, 0, 0, 0, 0, 0, 0, 10, 0, 10]);

      const header = await Promise.race([
        read(4),
        new Promise<undefined>((resolve) => setTimeout(resolve, 5000)),
      ]);

      if (!header) return false;

      const rects = new DataView(header.buffer).getUint16(2);

      for (let i = 0; i < rects; i++) {
        const rect = new DataView((await read(12)).buffer);

        await read(rect.getUint16(4) * rect.getUint16(6) * 4);
      }

      return header[0] === 0;
    },
    close() {
      ws.close();
    },
  };
}
