import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { resetSession } from "@/lib/session";
import { deliver, useOutgoing } from "./delivery";

function Outgoing() {
  return <p>{useOutgoing("bot:bot").length}</p>;
}

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
