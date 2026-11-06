import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { type MessageGateway, messageGatewaysQuery } from "./api";
import { queryClient } from "@/lib/api";
import { settle, waitFor, waitForIdle } from "@/test/wait-for";

test("owner validation, refresh, and failed disable preserve edits after its default bot is deleted", async () => {
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

  const gateway: MessageGateway = {
    id: "discord",
    label: "Discord",
    secretKey: "token",
    tokenConfigured: false,
    status: "disconnected",
    error: null,
    pendingCount: 0,
    failedCount: 0,
    config: {
      enabled: true,
      defaultBotId: "00000000-0000-4000-8000-000000000001",
      ownerId: null,
      allowedChannelIds: [],
      allowDirectMessages: false,
      aliases: [],
    },
  };

  const bodies: string[] = [];

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (path === "/v1/message-gateways")
          return Response.json({ gateways: [gateway] });

        if (path === "/v1/agents") return Response.json([]);

        if (path === "/v1/plugin-settings")
          return Response.json({ plugins: [] });

        if (path === "/v1/message-gateways/discord" && init?.method === "PUT") {
          bodies.push(await new Response(init.body).text());

          return Response.json(
            { error: "Could not save gateway" },
            { status: 500 },
          );
        }

        throw new Error(`Unexpected request: ${path}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { MessageGatewaySettings } = await import("./message-gateways");
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <MessageGatewaySettings gatewayId="discord" />
          </SidebarProvider>
        </QueryClientProvider>,
      ),
    );
    await waitFor(
      () => container.querySelector("#gateway-discord-owner") !== null,
      "the gateway form",
    );

    expect(container.querySelector("#gateway-discord-senders")).toBeNull();
    expect(
      container.querySelector('label[for="gateway-discord-owner"]')
        ?.textContent,
    ).toBe("Owner Discord user ID");
    expect(container.querySelector("#gateway-discord-owner")?.tagName).toBe(
      "INPUT",
    );

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click(),
    );

    const owner = container.querySelector<HTMLInputElement>(
      "#gateway-discord-owner",
    )!;

    const enterOwner = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          "value",
        )!.set?.call(owner, value);
        owner.dispatchEvent(new Event("input", { bubbles: true }));
      });

    const submit = async () =>
      act(async () =>
        container
          .querySelector("form")!
          .dispatchEvent(
            new Event("submit", { bubbles: true, cancelable: true }),
          ),
      );

    for (const value of ["owner-a,owner-b", "owner-a owner-b"]) {
      await enterOwner(value);
      await submit();
      await waitFor(
        () =>
          owner.getAttribute("aria-invalid") === "true" &&
          container.textContent?.includes(
            "Enter one user ID, without spaces or commas.",
          ) === true,
        "the validation error",
      );
      await settle();

      expect(bodies).toHaveLength(0);
      expect(owner.value).toBe(value);
    }

    await enterOwner("owner-a");
    await act(async () =>
      queryClient.setQueryData(messageGatewaysQuery.queryKey, [
        { ...gateway, status: "error", error: "Token missing", failedCount: 2 },
      ]),
    );

    await waitFor(
      () => container.textContent?.includes("Token missing") === true,
      "the refreshed status",
    );

    expect(owner.value).toBe("owner-a");
    expect(container.textContent).toContain("2 failed");
    expect(container.textContent).toContain("Unsaved changes");

    await submit();
    await waitFor(
      () => container.textContent?.includes("Could not save gateway") === true,
      "the save error",
    );

    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toStrictEqual({
      enabled: false,
      defaultBotId: "00000000-0000-4000-8000-000000000001",
      ownerId: "owner-a",
      allowedChannelIds: [],
      allowDirectMessages: false,
      aliases: [],
    });
    expect(owner.value).toBe("owner-a");
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
});

test("a gateway with channels and aliases renders where crypto.randomUUID is missing", async () => {
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

  const gateway: MessageGateway = {
    id: "discord",
    label: "Discord",
    secretKey: "token",
    tokenConfigured: true,
    status: "disconnected",
    error: null,
    pendingCount: 0,
    failedCount: 0,
    config: {
      enabled: true,
      defaultBotId: "00000000-0000-4000-8000-000000000001",
      ownerId: "owner",
      allowedChannelIds: ["channel"],
      allowDirectMessages: false,
      aliases: [
        { handle: "kev", botId: "00000000-0000-4000-8000-000000000001" },
      ],
    },
  };

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (path === "/v1/message-gateways")
          return Response.json({ gateways: [gateway] });

        if (path === "/v1/agents") return Response.json([]);

        if (path === "/v1/plugin-settings")
          return Response.json({ plugins: [] });

        throw new Error(`Unexpected request: ${path}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const randomUUID = spyOn(crypto, "randomUUID").mockImplementation(() => {
    throw new TypeError("crypto.randomUUID is not a function");
  });

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { MessageGatewaySettings } = await import("./message-gateways");
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);

  // The error is thrown in render, so without this React unmounts the tree and reports it.
  const consoleError = spyOn(console, "error").mockImplementation(() => {});

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <MessageGatewaySettings gatewayId="discord" />
          </SidebarProvider>
        </QueryClientProvider>,
      ),
    );

    await waitFor(
      () => container.querySelector("#gateway-discord-owner") !== null,
      "the gateway form",
    );
    await waitForIdle(queryClient);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();
    randomUUID.mockRestore();
    consoleError.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
