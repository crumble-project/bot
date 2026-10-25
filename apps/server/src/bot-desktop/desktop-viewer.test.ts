import { expect, test } from "bun:test";
import { bridgeDesktop, ViewerTickets, viewerPage } from "./desktop-viewer";

test("a ticket is redeemed once, and not after it expires", () => {
  let now = 0;
  const tickets = new ViewerTickets(() => now);
  const { ticket } = tickets.issue("bot-a");

  expect(tickets.redeem(ticket)).toBe("bot-a");
  expect(tickets.redeem(ticket)).toBeUndefined();

  const late = tickets.issue("bot-a").ticket;
  now = 61_000;
  expect(tickets.redeem(late)).toBeUndefined();
});

test("the viewer page connects to its ticket's stream and loads noVNC from the server", () => {
  const page = viewerPage("abc");

  expect(page).toContain("/desktop-viewer/novnc/core/rfb.js");
  expect(page).toContain("/desktop-viewer/abc/websockify");
});

test("the bridge filters the viewer's input and forwards the desktop's output", async () => {
  const toViewer: Uint8Array[] = [];
  const toDesktop: Uint8Array[] = [];
  let allowed = false;

  async function* output() {
    yield new TextEncoder().encode("RFB 003.008\n");
  }

  const bridge = bridgeDesktop({
    stream: {
      write: async (d) => void toDesktop.push(d),
      output: output(),
      close: async () => {},
    },
    allowInput: () => allowed,
    send: (d) => toViewer.push(d),
    close: () => {},
  });

  bridge.receive(
    new Uint8Array([...new TextEncoder().encode("RFB 003.008\n"), 1, 1]),
  );
  bridge.receive(new Uint8Array([5, 0, 0, 1, 0, 1]));
  allowed = true;
  bridge.receive(new Uint8Array([5, 0, 0, 2, 0, 2]));
  await Bun.sleep(10);

  expect(new TextDecoder().decode(toViewer[0])).toBe("RFB 003.008\n");
  expect(toDesktop.map((d) => d[0])).toEqual([82, 5]); // handshake ("R..."), then only the allowed pointer event
  await bridge.close();
});
