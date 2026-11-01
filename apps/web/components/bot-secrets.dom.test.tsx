import { expect, spyOn, test } from "bun:test";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { type Credentials, type Logins, queryClient } from "@/lib/api";
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

const acme = {
  name: "ACME_TOKEN",
  hosts: ["api.acme.com"],
  passwordManager: null,
  reference: null,
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
  lastUsedAt: null,
  lastError: null,
  github: false,
} satisfies Credentials["credentials"][number];

const moreAcmeHosts = {
  name: "ACME_TOKEN",
  hosts: ["api.acme.com", "uploads.acme.com"],
  reason: "Uploads",
  requestedAt: "2026-10-30T11:00:00.000Z",
} satisfies Credentials["requests"][number];

/**
 * Renders `ui` in a happy-dom window with one bot, `bot`, whose API answers GETs from `listings`, and runs `check`.
 * Returns each non-GET request the page sent.
 */
async function render(
  listings: {
    "/v1/agents/bot/logins"?: Logins;
    "/v1/agents/bot/credentials"?: Credentials;
  },
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

  // SAFETY: The paint spy prevents use of canvas methods other than setTransform and clearRect.
  const context = spyOn(
    window.HTMLCanvasElement.prototype,
    "getContext",
  ).mockReturnValue({ setTransform() {}, clearRect() {} } as never);

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

        const answers = new Map<string, unknown>([
          ["/v1/agents", [{ id: "bot", name: "Bot", avatar: "" }]],
          ["/v1/password-managers", { passwordManagers: [] }],
          ...Object.entries(listings),
        ]);

        return answers.has(path)
          ? Response.json(answers.get(path))
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

/** Opens the first "Waiting for you" row's menu and selects Decline. */
async function declineFirstRequest(container: HTMLElement) {
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
}

/** A settings page inside the sidebar it needs. */
const page = async (load: () => Promise<ReactNode>) => {
  const { SidebarProvider } = await import("@/components/ui/sidebar");

  return <SidebarProvider>{await load()}</SidebarProvider>;
};

/** The chat card for a request tool's result. */
const requestCard = async (
  toolName: string,
  toolDetails: Logins["requests"][number] | Credentials["requests"][number],
) => {
  const { ToolResultRow } = await import("@/features/chat/transcript");

  return (
    <ToolResultRow
      botId="bot"
      message={{
        id: "m1",
        role: "toolResult",
        content: "",
        entryId: "e1",
        toolName,
        toolDetails,
      }}
    />
  );
};

test("declining a request for more hosts keeps the saved login", async () => {
  const sent = await render(
    { "/v1/agents/bot/logins": { logins: [github], requests: [moreHosts] } },
    () =>
      page(async () => {
        const { LoginsSettings } = await import("@/features/logins/logins");

        return <LoginsSettings />;
      }),
    declineFirstRequest,
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
    { "/v1/agents/bot/logins": { logins: [github], requests: [moreHosts] } },
    () => requestCard("request_login", moreHosts),
    async (container) => {
      expect(container.textContent).toContain("Add login");
      expect(container.textContent).not.toContain("Saved");
    },
  );
});

test("declining a request for more hosts keeps the saved credential", async () => {
  const sent = await render(
    {
      "/v1/agents/bot/credentials": {
        credentials: [acme],
        requests: [moreAcmeHosts],
      },
    },
    () =>
      page(async () => {
        const { CredentialsSettings } =
          await import("@/features/credentials/credentials");

        return <CredentialsSettings />;
      }),
    declineFirstRequest,
  );

  expect(sent).toEqual(["POST /v1/agents/bot/credentials/ACME_TOKEN/decline"]);
});

test("a request newer than the cached credentials offers its answers", async () => {
  // The cache was filled before the bot asked, and is still fresh.
  queryClient.setQueryData(["credentials", "bot"], {
    credentials: [acme],
    requests: [],
  });

  await render(
    {
      "/v1/agents/bot/credentials": {
        credentials: [acme],
        requests: [moreAcmeHosts],
      },
    },
    () => requestCard("request_credential", moreAcmeHosts),
    async (container) => {
      expect(
        container.querySelector('input[placeholder="Credential value"]'),
      ).toBeTruthy();
      expect(container.textContent).not.toContain("Saved");
    },
  );
});
