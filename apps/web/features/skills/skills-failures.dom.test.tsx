import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { BotPainter } from "@/features/bots/bot-avatar";

for (const scenario of ["failure", "refresh"] as const) {
  test(`personal skills ${scenario} preserves the rest of the page`, async () => {
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
      KeyboardEvent: window.KeyboardEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
      devicePixelRatio: 1,
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      Path2D: class {
        moveTo() {}
        ellipse() {}
        roundRect() {}
        lineTo() {}
        closePath() {}
        bezierCurveTo() {}
      },
    };

    for (const [key, value] of Object.entries(values))
      Object.defineProperty(globalThis, key, { configurable: true, value });

    const paint = spyOn(BotPainter.prototype, "paint").mockImplementation(
      () => {},
    );

    // SAFETY: The paint spy prevents use of canvas methods other than setTransform.
    const context = spyOn(
      window.HTMLCanvasElement.prototype,
      "getContext",
    ).mockReturnValue({ setTransform() {} } as never);

    let release: ((value: Response) => void) | undefined;
    let requests = 0;

    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const path = input instanceof Request ? input.url : input.toString();

          if (path === "/v1/agents")
            return Response.json([
              { id: "bad", name: "Bad Bot", avatar: "" },
              { id: "good", name: "Good Bot", avatar: "" },
            ]);

          if (path === "/v1/skills")
            return Response.json([
              {
                id: "shared",
                name: "Shared skill",
                source: "shared",
                instructions: "Shared instructions",
              },
              {
                id: "default",
                name: "Default skill",
                source: "bundled",
                instructions: "Default instructions",
                path: "/default",
              },
            ]);

          if (path === "/v1/agents/good/skills")
            return Response.json([
              {
                id: "own",
                name: "Own skill",
                instructions: "Own instructions",
              },
            ]);

          if (path === "/v1/agents/bad/skills") {
            if (scenario === "failure")
              return new Response("unavailable", { status: 500 });
            requests++;

            if (requests > 1)
              return new Promise<Response>((resolve) => {
                release = resolve;
              });

            return Response.json([]);
          }

          return new Response("unexpected request", { status: 500 });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    );

    const defaultOptions = queryClient.getDefaultOptions();

    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 10_000 },
    });
    const { createRoot } = await import("react-dom/client");
    const { SidebarProvider } = await import("@/components/ui/sidebar");
    const { SkillsPage } = await import("./skills");
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    const settle = async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    };

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
      await settle();
      await settle();

      if (scenario === "failure") {
        expect(container.textContent).toContain("Shared skill");
        expect(container.textContent).toContain("Default skill");
        expect(container.textContent).toContain("Own skill");
        expect(container.textContent).toContain("Bad Bot");
        expect(container.textContent).toContain(
          "Could not load Bad Bot's skills: unavailable",
        );

        const badPill = [...container.querySelectorAll("button")].find(
          (button) => button.textContent?.includes("Bad Bot"),
        );

        expect(badPill).toBeDefined();
        await act(async () => {
          badPill?.click();
        });
        expect(container.textContent).not.toContain(
          "No skills of its own yet.",
        );
      } else {
        await act(async () => {
          void queryClient.invalidateQueries({
            queryKey: ["personal-skills", "bad"],
          });
        });
        await settle();
        expect(release).toBeDefined();
        expect(
          container.querySelector<HTMLButtonElement>('[title="Refresh"]')
            ?.disabled,
        ).toBe(true);
        await act(async () => {
          release?.(Response.json([]));
        });
        await settle();
        expect(
          container.querySelector<HTMLButtonElement>('[title="Refresh"]')
            ?.disabled,
        ).toBe(false);
      }
    } finally {
      release?.(Response.json([]));
      await act(async () => root.unmount());
      queryClient.clear();
      queryClient.setDefaultOptions(defaultOptions);
      fetch.mockRestore();
      paint.mockRestore();
      context.mockRestore();

      for (const key of Object.keys(values)) {
        if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
        else Reflect.deleteProperty(globalThis, key);
      }

      window.close();
    }
  });
}
