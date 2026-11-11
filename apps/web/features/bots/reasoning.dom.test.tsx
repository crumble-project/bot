import { expect, spyOn, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import {
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { z } from "zod";
import { waitFor, waitForIdle } from "@/test/wait-for";
import { useBotFields } from "./bot-fields";
import { matchingReasoningPreview } from "./reasoning";

const options = [
  { value: "off", label: "Off" },
  { value: "high", label: "High" },
];

test("initial preview tolerates missing draft fields without a previous query", () => {
  expect(
    matchingReasoningPreview(undefined, undefined, undefined, undefined),
  ).toBeUndefined();
});

test("draft switches ignore late previews and retain a pending choice", async () => {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    HTMLElement: { configurable: true, value: window.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  const pending = new Map<string, (response: Response) => void>();

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        if (z.string().safeParse(input).data === "/v1/providers")
          return Response.json([]);

        const body: { provider: string; model: string; thinkingLevel: string } =
          JSON.parse(z.string().parse(init?.body));

        return new Promise<Response>((resolve) =>
          pending.set(
            `${body.provider}/${body.model}/${body.thinkingLevel}`,
            resolve,
          ),
        );
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  function Harness() {
    const { selection } = useBotFields({
      provider: "a",
      model: "first",
      name: "Bot",
    });

    return (
      <>
        <output>{`${selection.level}:${selection.options.map((o) => o.label).join(",")}:${selection.previewReady}`}</output>
        <button
          onClick={() => {
            selection.setProvider("b");
            selection.setModel("second");
          }}
        >
          Switch
        </button>
        <button onClick={() => selection.setThinkingLevel("high")}>High</button>
      </>
    );
  }

  const resolve = async (
    key: string,
    effectiveLevel: string,
    labels = options,
  ) => {
    await act(async () => {
      pending.get(key)?.(Response.json({ options: labels, effectiveLevel }));
    });
  };

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Harness />
        </QueryClientProvider>,
      );
    });
    await waitFor(() => pending.has("a/first/off"));
    await act(async () => {
      container.querySelectorAll("button")[0]?.click();
    });
    await waitFor(() => pending.has("b/second/off"));
    await resolve("b/second/off", "off");
    await waitFor(
      () => container.textContent?.includes("off:Off,High:true") ?? false,
    );
    await resolve("a/first/off", "high", [{ value: "high", label: "Old" }]);
    expect(container.textContent).toContain("off:Off,High:true");
    await act(async () => {
      container.querySelectorAll("button")[1]?.click();
    });
    await waitFor(() => pending.has("b/second/high"));
    expect(container.textContent).toContain("high:Off,High:false");
    await resolve("b/second/high", "high");
    await waitFor(
      () => container.textContent?.includes("high:Off,High:true") ?? false,
    );
    await waitForIdle(client);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    fetch.mockRestore();
    await window.happyDOM.abort();
    Object.defineProperties(globalThis, globals);
  }
});

test("failed reasoning preview can be retried without losing the bot draft", async () => {
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
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  let attempts = 0;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        const path = z.string().parse(input);

        if (path === "/v1/reasoning/preview") {
          attempts++;

          return attempts === 1
            ? new Response("Unavailable", { status: 503 })
            : Response.json({ options, effectiveLevel: "off" });
        }

        if (path.startsWith("/v1/models")) return Response.json([]);

        if (path === "/v1/capabilities") return Response.json({});

        return Response.json([]);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const { createRoot } = await import("react-dom/client");
  const { BotFields } = await import("./bot-fields");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const router = createRouter({ routeTree: createRootRoute() });
  let submitted = false;

  function Harness() {
    const fields = useBotFields({
      provider: "a",
      model: "first",
      name: "My draft",
    });

    return (
      <>
        <BotFields
          fields={fields}
          formId="bot"
          onSubmit={() => {
            submitted = true;
          }}
        />
        <button form="bot" disabled={fields.invalid}>
          Save
        </button>
      </>
    );
  }

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterContextProvider router={router}>
            <Harness />
          </RouterContextProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(
      () =>
        container.textContent?.includes("Could not load reasoning options") ??
        false,
    );
    expect(
      container.querySelector<HTMLButtonElement>('[form="bot"]')?.disabled,
    ).toBe(true);
    expect(container.querySelector<HTMLInputElement>("#model")?.value).toBe(
      "first",
    );

    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );

    await act(async () => {
      retry?.click();
    });
    await waitFor(
      () =>
        !container.querySelector<HTMLButtonElement>('[form="bot"]')?.disabled,
    );
    expect(container.querySelector<HTMLInputElement>("#model")?.value).toBe(
      "first",
    );
    expect(container.querySelector<HTMLInputElement>("#name")?.value).toBe(
      "My draft",
    );
    await act(async () => {
      container.querySelector<HTMLFormElement>("form")?.requestSubmit();
    });
    expect(submitted).toBe(true);
    await waitForIdle(client);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    fetch.mockRestore();
    await window.happyDOM.abort();
    Object.defineProperties(globalThis, globals);
  }
});
