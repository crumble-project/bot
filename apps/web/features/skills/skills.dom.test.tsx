import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { waitFor, waitForIdle } from "@/test/wait-for";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";

test("deleting the first same-name skill keeps the second", async () => {
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

  let skills = [
    { id: "first", name: "Duplicate", instructions: "First instructions" },
    { id: "second", name: "Duplicate", instructions: "Second instructions" },
  ];

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (init?.method === "DELETE") {
          skills = skills.filter(
            (skill) => path !== `/v1/agents/bot/skills/${skill.id}`,
          );

          return new Response(null, { status: 204 });
        }

        const listings = new Map<string, unknown>([
          ["/v1/agents/bot/skills", skills],
          [
            "/v1/agents",
            [
              {
                id: "bot",
                name: "Bot",
                avatar: defaultAvatarDefinition("bot"),
                skills,
              },
            ],
          ],
          ["/v1/skills", []],
        ]);

        return listings.has(path)
          ? Response.json(listings.get(path))
          : new Response("unexpected request", { status: 500 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { SkillsPage } = await import("./skills");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <SkillsPage />
          </SidebarProvider>
        </QueryClientProvider>,
      );
    });

    const firstRow = () =>
      [...container.querySelectorAll("button")].find((button) =>
        button.textContent?.includes("First instructions"),
      )?.parentElement;

    await waitFor(() => firstRow() !== undefined);

    const row = firstRow();

    if (!row) throw new Error("Expected the first skill's row");
    await act(async () => {
      const button = row.querySelector<HTMLButtonElement>('[title="More"]')!;
      button.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowDown",
          bubbles: true,
        }),
      );
    });

    const menuItem = [
      ...document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ].find((item) => item.textContent?.includes("Delete"));

    if (!menuItem) throw new Error("Expected a Delete menu item");
    await act(async () => {
      menuItem.click();
    });

    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    );

    if (!confirm) throw new Error("Expected a Delete confirmation");
    await act(async () => {
      confirm.click();
    });

    await waitFor(() => !container.textContent?.includes("First instructions"));

    expect(skills.map((skill) => skill.id)).toEqual(["second"]);
    expect(container.textContent).toContain("Second instructions");
    await waitForIdle(queryClient);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();

    for (const key of [
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
    ]) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
