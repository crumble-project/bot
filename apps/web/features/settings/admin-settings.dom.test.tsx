import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { waitFor, waitForIdle } from "@/test/wait-for";

test("closing the invite sheet leaves the shown invite the only one minted", async () => {
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

  const removedListeners = spyOn(window, "removeEventListener");
  let minted = 0;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (init?.method === "POST") {
          minted++;

          return Response.json(
            { id: `i${minted}`, url: `http://invite/${minted}` },
            { status: 201 },
          );
        }

        if (path.endsWith("/get-session"))
          return Response.json({
            session: { id: "s", userId: "u" },
            user: { id: "u", role: "admin" },
          });

        if (path === "/v1/admin/users") return Response.json({ users: [] });

        if (path === "/v1/admin/invites") return Response.json({ invites: [] });

        if (path === "/v1/admin/settings") return Response.json({});

        return Response.json(null);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { UsersPage } = await import("./admin-settings");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const button = (label: string) =>
    [...document.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === label,
    );

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <UsersPage />
          </SidebarProvider>
        </QueryClientProvider>,
      ),
    );
    await waitFor(() => button("Invite")?.disabled === false, "Invite");
    await act(async () => button("Invite")?.click());
    await waitFor(() => button("Done") !== undefined, "the minted invite");
    expect(minted).toBe(1);
    await act(async () => button("Done")?.click());
    await waitFor(() => button("Done") === undefined, "the sheet to close");
    await waitForIdle(queryClient);
    expect(minted).toBe(1);
  } finally {
    await act(async () => root.unmount());
    // The auth client stops a second after its last consumer, and needs the window to.
    await waitFor(
      () => removedListeners.mock.calls.some(([type]) => type === "storage"),
      "the session store to stop",
    );
    queryClient.clear();
    fetch.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
