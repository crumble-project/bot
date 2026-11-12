import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { resetSession } from "@/lib/session";
import { deliver, discard, useOutgoing } from "./delivery";

function Outgoing() {
  return <p>{useOutgoing("bot:bot").length}</p>;
}

test("delivery retries the same request and file IDs", async () => {
  const bodies: string[] = [];

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(await new Request("http://localhost", init).text());

        return new Response("down", { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const message = {
    requestId: "same-request",
    content: "hello",
    uploads: [
      {
        id: "file-id",
        name: "file.pdf",
        mimeType: "application/pdf",
        status: "ready" as const,
      },
    ],
  };

  try {
    await deliver("bot:delivery-test", "/v1/agents/bot/messages", message);
    await deliver("bot:delivery-test", "/v1/agents/bot/messages", message);
    expect(bodies).toHaveLength(2);
    expect(JSON.parse(bodies[0]!)).toEqual({
      content: "hello",
      requestId: "same-request",
      files: ["file-id"],
    });
    expect(bodies[1]).toBe(bodies[0]);
  } finally {
    fetchMock.mockRestore();
    discard("bot:delivery-test", "same-request");
  }
});

test("resetting the session drops the old account's unsent messages", async () => {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);

  const values = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    localStorage: window.localStorage,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response("down", { status: 503 }), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () => root.render(<Outgoing />));
    await act(async () => {
      await deliver("bot:bot", "/v1/agents/bot/messages", {
        requestId: "request",
        content: "Hello",
        uploads: [],
      });
    });
    expect(container.textContent).toBe("1");

    await act(async () => resetSession());
    expect(container.textContent).toBe("0");
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
