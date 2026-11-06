import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { queryClient } from "@/lib/api";
import { waitFor, waitForIdle } from "@/test/wait-for";

const GLOBALS = [
  "window",
  "document",
  "HTMLElement",
  "Element",
  "Node",
  "MutationObserver",
  "getComputedStyle",
  "Event",
  "IS_REACT_ACT_ENVIRONMENT",
  "devicePixelRatio",
  "requestAnimationFrame",
  "cancelAnimationFrame",
];

// happy-dom's :disabled ignores a disabled ancestor fieldset, which browsers honor.
const disabled = (control: Element) =>
  control.matches(":disabled") ||
  control.closest("fieldset[disabled]") !== null;

test("editing is locked until a pending save answers", async () => {
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
  });

  const answer = Promise.withResolvers<Response>();

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === "PATCH"
          ? answer.promise
          : Response.json([
              {
                id: "bot",
                name: "Bot",
                avatar: defaultAvatarDefinition("bot"),
              },
            ]),
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const { AvatarsPage } = await import("./avatars");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <AvatarsPage />
          </SidebarProvider>
        </QueryClientProvider>,
      );
    });
    await waitFor(
      () => container.querySelector('select option[value="bot"]') !== null,
      "the bot to load",
    );

    const select = container.querySelector("select")!;
    await act(async () => {
      select.value = "bot";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const saveButton = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save avatar to bot",
    )!;

    await act(async () => saveButton.click());
    await waitFor(() => disabled(select), "the page to lock");

    const editable = [
      ...container.querySelectorAll(
        "select, input, textarea, button:not([data-slot=sidebar-trigger])",
      ),
    ];

    expect(editable.length).toBeGreaterThan(2);
    expect(
      editable.flatMap((control) =>
        disabled(control) ? [] : [control.outerHTML.slice(0, 80)],
      ),
    ).toEqual([]);

    await act(async () => answer.resolve(new Response(null, { status: 204 })));
    await waitFor(() => !disabled(select), "the page to unlock");
    await waitForIdle(queryClient);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();

    for (const key of GLOBALS) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
