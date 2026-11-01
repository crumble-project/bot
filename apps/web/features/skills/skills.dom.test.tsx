import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { BotPainter } from "@/features/bots/bot-avatar";

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

  const paint = spyOn(BotPainter.prototype, "paint").mockImplementation(
    () => {},
  );

  // SAFETY: The paint spy prevents use of canvas methods other than setTransform and clearRect.
  const context = spyOn(
    window.HTMLCanvasElement.prototype,
    "getContext",
  ).mockReturnValue({ setTransform() {}, clearRect() {} } as never);

  let skills = [
    { id: "first", name: "Duplicate", instructions: "First instructions" },
    { id: "second", name: "Duplicate", instructions: "Second instructions" },
  ];

  const patchSkills = (patch: { name: string; instructions: string }[]) => {
    const kept = new Set<string>();

    for (const input of patch) {
      const match = skills.find(
        (skill) => skill.name === input.name && !kept.has(skill.id),
      );

      if (match) {
        kept.add(match.id);
        match.instructions = input.instructions;
      }
    }

    skills = skills.filter((skill) => kept.has(skill.id));
  };

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (path === "/v1/agents/bot" && init?.method === "PATCH") {
          const body: { skills: { name: string; instructions: string }[] } =
            JSON.parse(await new Response(init.body).text());

          patchSkills(body.skills);

          return Response.json({});
        }

        if (init?.method === "DELETE") {
          skills = skills.filter(
            (skill) => path !== `/v1/agents/bot/skills/${skill.id}`,
          );

          return new Response(null, { status: 204 });
        }

        const listings = new Map<string, unknown>([
          ["/v1/agents/bot/skills", skills],
          ["/v1/agents", [{ id: "bot", name: "Bot", avatar: "", skills }]],
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
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const row = [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("First instructions"),
    )?.parentElement;

    expect(row).toBeTruthy();
    await act(async () => {
      const button = row!.querySelector<HTMLButtonElement>('[title="More"]')!;
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

    expect(menuItem).toBeTruthy();
    await act(async () => {
      menuItem!.click();
    });

    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    );

    expect(confirm).toBeTruthy();
    await act(async () => {
      confirm!.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(skills.map((skill) => skill.id)).toEqual(["second"]);
    expect(container.textContent).toContain("Second instructions");
    expect(container.textContent).not.toContain("First instructions");
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();
    paint.mockRestore();
    context.mockRestore();

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
