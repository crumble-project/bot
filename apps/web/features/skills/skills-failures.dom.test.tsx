import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { waitFor, waitForIdle } from "@/test/wait-for";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import { botSkillsQuery } from "./api";

for (const scenario of ["failure", "refresh"] as const) {
  test(`bot skills ${scenario} preserves the rest of the page`, async () => {
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

    let release: ((value: Response) => void) | undefined;
    let requests = 0;

    const fetch = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async (input: RequestInfo | URL) => {
          const path = input instanceof Request ? input.url : input.toString();

          if (path === "/v1/agents")
            return Response.json([
              {
                id: "bad",
                name: "Bad Bot",
                avatar: defaultAvatarDefinition("bad"),
              },
              {
                id: "good",
                name: "Good Bot",
                avatar: defaultAvatarDefinition("good"),
              },
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

    const refreshDisabled = () =>
      container.querySelector<HTMLButtonElement>('[title="Refresh"]')?.disabled;

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

      if (scenario === "failure") {
        const error = "Could not load Bad Bot's skills: unavailable";

        await waitFor(() => container.textContent?.includes(error) === true);
        expect(container.textContent).toContain("Shared skill");
        expect(container.textContent).toContain("Default skill");
        expect(container.textContent).toContain("Own skill");
        expect(container.textContent).toContain("Bad Bot");

        const badPill = [...container.querySelectorAll("button")].find(
          (button) => button.textContent?.includes("Bad Bot"),
        );

        if (!badPill) throw new Error("Expected a Bad Bot pill");
        await act(async () => {
          badPill.click();
        });
        expect(container.textContent).not.toContain(
          "No skills of its own yet.",
        );
      } else {
        await waitFor(() => refreshDisabled() === false, "the page to load");
        await act(async () => {
          void queryClient.invalidateQueries({
            queryKey: botSkillsQuery("bad").queryKey,
          });
        });
        await waitFor(() => release !== undefined, "the second request");
        await waitFor(() => refreshDisabled() === true, "Refresh to lock");
        await act(async () => {
          release?.(Response.json([]));
        });
        await waitFor(() => refreshDisabled() === false, "Refresh to unlock");
      }

      await waitForIdle(queryClient);
    } finally {
      release?.(Response.json([]));
      await act(async () => root.unmount());
      queryClient.clear();
      queryClient.setDefaultOptions(defaultOptions);
      fetch.mockRestore();

      for (const key of Object.keys(values)) {
        if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
        else Reflect.deleteProperty(globalThis, key);
      }

      window.close();
    }
  });
}
