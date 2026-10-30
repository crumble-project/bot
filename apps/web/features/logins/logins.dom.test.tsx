import { expect, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { type Logins, queryClient } from "@/lib/api";
import { BotPainter } from "@/features/bots/bot-avatar";

const GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "MutationObserver",
  "getComputedStyle",
  "Event",
  "KeyboardEvent",
  "IS_REACT_ACT_ENVIRONMENT",
  "devicePixelRatio",
  "Path2D",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

const github = {
  name: "github",
  hosts: ["github.com"],
  fields: {
    username: { passwordManager: null, reference: null },
    password: { passwordManager: null, reference: null },
  },
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
  lastUsedAt: null,
  lastError: null,
} satisfies Logins["logins"][number];

const moreHosts = {
  name: "github",
  hosts: ["github.com", "gist.github.com"],
  reason: "Gists",
  oneTimeCode: false,
  requestedAt: "2026-10-30T11:00:00.000Z",
} satisfies Logins["requests"][number];

/**
 * Renders `ui` in a happy-dom window with `logins` as bot `bot`'s logins, and runs `check` on it.
 * Returns each non-GET request the page sent.
 */
async function render(
  logins: Logins,
  ui: () => Promise<ReactNode>,
  check: (container: HTMLElement) => Promise<void>,
) {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    HTMLElement: { configurable: true, value: window.HTMLElement },
    Element: { configurable: true, value: window.Element },
    Node: { configurable: true, value: window.Node },
    MutationObserver: { configurable: true, value: window.MutationObserver },
    getComputedStyle: {
      configurable: true,
      value: window.getComputedStyle.bind(window),
    },
    Event: { configurable: true, value: window.Event },
    KeyboardEvent: { configurable: true, value: window.KeyboardEvent },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
    devicePixelRatio: { configurable: true, value: 1 },
    requestAnimationFrame: {
      configurable: true,
      value: window.requestAnimationFrame.bind(window),
    },
    cancelAnimationFrame: {
      configurable: true,
      value: window.cancelAnimationFrame.bind(window),
    },
    Path2D: {
      configurable: true,
      value: class {
        moveTo() {}
        ellipse() {}
        roundRect() {}
        lineTo() {}
        closePath() {}
        bezierCurveTo() {}
      },
    },
  });

  const paint = spyOn(BotPainter.prototype, "paint").mockImplementation(
    () => {},
  );

  // SAFETY: The paint spy prevents use of canvas methods other than setTransform.
  const context = spyOn(
    window.HTMLCanvasElement.prototype,
    "getContext",
  ).mockReturnValue({ setTransform() {} } as never);

  const sent: string[] = [];

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();
        const method = init?.method ?? "GET";

        if (method !== "GET") {
          sent.push(`${method} ${path}`);

          return new Response(null, { status: 204 });
        }

        const listings = new Map<string, unknown>([
          ["/v1/agents", [{ id: "bot", name: "Bot", avatar: "" }]],
          ["/v1/agents/bot/logins", logins],
          ["/v1/password-managers", { passwordManagers: [] }],
        ]);

        return listings.has(path)
          ? Response.json(listings.get(path))
          : new Response("unexpected request", { status: 500 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const element = await ui();

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          {element}
        </QueryClientProvider>,
      );
    });
    await settle();
    await settle();
    await check(container);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();
    paint.mockRestore();
    context.mockRestore();

    for (const key of GLOBALS) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }

  return sent;
}

test("declining a request for more hosts keeps the saved login", async () => {
  const sent = await render(
    { logins: [github], requests: [moreHosts] },
    async () => {
      const { SidebarProvider } = await import("@/components/ui/sidebar");
      const { LoginsSettings } = await import("./logins");

      return (
        <SidebarProvider>
          <LoginsSettings />
        </SidebarProvider>
      );
    },
    async (container) => {
      const row = [...container.querySelectorAll("span")].find((span) =>
        span.textContent?.includes("asks for"),
      )?.parentElement?.parentElement?.parentElement;

      expect(row).toBeTruthy();
      await act(async () => {
        row!
          .querySelector<HTMLButtonElement>('[title="More"]')!
          .dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
          );
      });

      const decline = [
        ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ].find((item) => item.textContent?.includes("Decline"));

      expect(decline).toBeTruthy();
      await act(async () => {
        decline!.click();
      });
      await settle();
    },
  );

  expect(sent).toEqual(["POST /v1/agents/bot/logins/github/decline"]);
});

test("a request newer than the cached logins offers its answers", async () => {
  // The cache was filled before the bot asked, and is still fresh.
  queryClient.setQueryData(["logins", "bot"], {
    logins: [github],
    requests: [],
  });

  await render(
    { logins: [github], requests: [moreHosts] },
    async () => {
      const { ToolResultRow } = await import("@/features/chat/transcript");

      return (
        <ToolResultRow
          botId="bot"
          message={{
            id: "m1",
            role: "toolResult",
            content: "",
            entryId: "e1",
            toolName: "request_login",
            toolDetails: moreHosts,
          }}
        />
      );
    },
    async (container) => {
      expect(container.textContent).toContain("Add login");
      expect(container.textContent).not.toContain("Saved");
    },
  );
});
