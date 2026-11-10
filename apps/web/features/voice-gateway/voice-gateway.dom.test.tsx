import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import type { VoiceGateway } from "./api";
import { queryClient } from "@/lib/api";
import { settle, waitFor, waitForIdle } from "@/test/wait-for";

const BOT_ID = "00000000-0000-4000-8000-000000000001";

const describeGateway = (
  overrides: Partial<VoiceGateway> = {},
): VoiceGateway => ({
  config: { enabled: false, ownerNumbers: [], lines: [] },
  token: null,
  status: "disconnected",
  connectedAt: null,
  lines: [],
  unavailableLines: [],
  ...overrides,
});

async function renderPage(
  respond: (path: string, init?: RequestInit) => Promise<Response | null>,
  run: (page: {
    container: HTMLElement;
    button: (label: string) => HTMLButtonElement | undefined;
    type: (input: HTMLInputElement, value: string) => Promise<void>;
  }) => Promise<void>,
) {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);

  const values = {
    window,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    Event: window.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();
        const response = await respond(path, init);

        if (response) return response;

        if (path === "/v1/agents")
          return Response.json([{ id: BOT_ID, name: "Ada", enabled: true }]);

        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { VoiceGatewaySettings } = await import("./voice-gateway");
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);

  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === label,
    );

  const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )!.set?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <VoiceGatewaySettings />
          </SidebarProvider>
        </QueryClientProvider>,
      ),
    );
    await run({ container, button, type });
    await waitForIdle(queryClient);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
}

test("invalid numbers and usernames show errors without saving, and a valid draft saves", async () => {
  const bodies: unknown[] = [];

  const stored = describeGateway({
    config: {
      enabled: false,
      ownerNumbers: ["+4930123"],
      lines: [
        {
          username: "ada",
          botId: BOT_ID,
          displayName: null,
          callsOwner: false,
        },
      ],
    },
  });

  await renderPage(
    async (path, init) => {
      if (path !== "/v1/voice-gateway") return null;

      if (init?.method !== "PUT") return Response.json(stored);

      const body = JSON.parse(await new Response(init.body).text());

      bodies.push(body);

      return Response.json({ ...stored, config: body });
    },
    async ({ container, type }) => {
      await waitFor(
        () => container.querySelector('input[aria-label="Number 1"]') !== null,
        "the form",
      );

      const number = container.querySelector<HTMLInputElement>(
        'input[aria-label="Number 1"]',
      )!;

      const username = container.querySelector<HTMLInputElement>(
        'input[aria-label="SIP username for line 1"]',
      )!;

      const submit = () =>
        act(async () =>
          container
            .querySelector("form")!
            .dispatchEvent(
              new Event("submit", { bubbles: true, cancelable: true }),
            ),
        );

      await type(number, "030 123");
      await type(username, "..");
      await submit();
      await waitFor(
        () =>
          container.textContent?.includes(
            "Use up to 32 digits, * or #, with an optional + in front.",
          ) === true,
        "the number error",
      );
      await settle();

      expect(container.textContent).toContain(
        "A SIP username cannot be . or ..",
      );
      expect(number.getAttribute("aria-invalid")).toBe("true");
      expect(bodies).toHaveLength(0);

      await type(number, "+4930999");
      await type(username, "ada-2");
      await act(async () =>
        container
          .querySelector<HTMLInputElement>(
            'input[aria-label="Line 1 can call you"]',
          )!
          .click(),
      );
      await submit();
      await waitFor(() => bodies.length === 1, "the save");

      expect(bodies[0]).toStrictEqual({
        enabled: false,
        ownerNumbers: ["+4930999"],
        lines: [
          {
            username: "ada-2",
            botId: BOT_ID,
            displayName: null,
            callsOwner: true,
            callsOthers: false,
          },
        ],
      });
      await waitFor(
        () => container.textContent?.includes("Saved") === true,
        "the saved state",
      );
    },
  );
});

test("a line's Calls others checkbox is described and saved as callsOthers", async () => {
  const bodies: unknown[] = [];

  const line = {
    username: "ada",
    botId: BOT_ID,
    displayName: null,
    callsOwner: false,
  };

  const stored = describeGateway({
    config: { enabled: false, ownerNumbers: ["+4930123"], lines: [line] },
  });

  await renderPage(
    async (path, init) => {
      if (path !== "/v1/voice-gateway") return null;

      if (init?.method !== "PUT") return Response.json(stored);

      const body = JSON.parse(await new Response(init.body).text());

      bodies.push(body);

      return Response.json({ ...stored, config: body });
    },
    async ({ container, button }) => {
      await waitFor(
        () =>
          container.querySelector(
            'input[aria-label="Line 1 can call other people"]',
          ) !== null,
        "the form",
      );

      const others = container.querySelector<HTMLInputElement>(
        'input[aria-label="Line 1 can call other people"]',
      )!;

      expect(
        document.getElementById(others.getAttribute("aria-describedby")!)
          ?.textContent,
      ).toBe(
        "Only for calls to friends and family who know about it and agreed beforehand. The legal situation for calling anyone else is not settled.",
      );
      expect(others.checked).toBe(false);
      expect(button("Save")?.disabled).toBe(true);

      await act(async () => others.click());
      await act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );
      await waitFor(() => bodies.length === 1, "the save");

      expect(bodies[0]).toStrictEqual({
        ...stored.config,
        lines: [{ ...line, callsOthers: true }],
      });
    },
  );
});

test("issuing over an existing token asks first, and the new token is shown once", async () => {
  let issued = 0;

  await renderPage(
    async (path, init) => {
      if (path === "/v1/voice-gateway")
        return Response.json(
          describeGateway({ token: { issuedAt: "2026-11-01T10:00:00.000Z" } }),
        );

      if (path === "/v1/voice-gateway/token" && init?.method === "POST") {
        issued++;

        return Response.json(
          { token: "account.secret", issuedAt: "2026-11-09T10:00:00.000Z" },
          { status: 201 },
        );
      }

      return null;
    },
    async ({ button }) => {
      const tokenInput = () =>
        document.querySelector<HTMLInputElement>(
          'input[aria-label="Voice gateway token"]',
        );

      await waitFor(() => button("Issue new token") !== undefined, "the row");
      await act(async () => button("Issue new token")!.click());
      await waitFor(
        () =>
          document
            .querySelector('[role="alertdialog"]')
            ?.textContent?.includes(
              "The current token stops working at once",
            ) === true,
        "the confirmation",
      );

      expect(issued).toBe(0);

      const confirm = [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="alertdialog"] button',
        ),
      ].find((each) => each.textContent?.trim() === "Issue new token")!;

      await act(async () => confirm.click());
      await waitFor(
        () => tokenInput()?.value === "account.secret",
        "the token",
      );

      expect(issued).toBe(1);

      await act(async () => button("Done")!.click());
      await waitFor(() => tokenInput() === null, "the sheet to close");

      expect(document.body.textContent).not.toContain("account.secret");
      expect(issued).toBe(1);
    },
  );
});
