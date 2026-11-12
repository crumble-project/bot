import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { queryClient } from "@/lib/api";
import { waitFor } from "@/test/wait-for";

test("failed downloads show an error instead of an unhandled rejection", async () => {
  await withLibrary(
    false,
    async (container) => {
      await waitFor(
        () => container.textContent?.includes("page.html") === true,
      );

      const button = Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Download",
      )!;

      await act(async () => button.click());
      await waitFor(
        () =>
          container
            .querySelector('[role="alert"]')
            ?.textContent?.includes("Download unavailable") === true,
      );
    },
    false,
    true,
  );
});

async function withLibrary(
  empty: boolean,
  run: (
    container: HTMLElement,
    calls: string[],
    blobs: Blob[],
  ) => Promise<void>,
  many = false,
  failedDownload = false,
) {
  const window = new Window({ url: "http://localhost" });
  const original = Object.getOwnPropertyDescriptors(globalThis);
  const urlOriginal = Object.getOwnPropertyDescriptors(URL);
  const calls: string[] = [];
  const blobs: Blob[] = [];

  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    localStorage: window.localStorage,
    location: window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
    scrollTo: () => {},
  };

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  window.HTMLAnchorElement.prototype.click = () => {};

  URL.createObjectURL = (blob) => {
    if (blob instanceof Blob) blobs.push(blob);

    return "blob:test";
  };

  URL.revokeObjectURL = () => {};

  let deleted = false;

  const fetchMock = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();
        calls.push(`${init?.method ?? "GET"} ${path}`);

        if (init?.method === "DELETE") {
          deleted = true;

          return new Response(null, { status: 204 });
        }

        if (path.includes("?") && many) {
          const page = path.includes("before=")
            ? [
                {
                  id: "older",
                  name: "older.zip",
                  mimeType: "application/zip",
                  size: 1,
                  createdAt: "2026-01-01",
                },
              ]
            : Array.from({ length: 50 }, (_, index) => ({
                id: `file-${index}`,
                name: `file-${index}.zip`,
                mimeType: "application/zip",
                size: 1,
                createdAt: "2026-02-01",
              }));

          return Response.json(page);
        }

        if (path.includes("?"))
          return Response.json(
            empty || deleted
              ? []
              : [
                  {
                    id: "new",
                    name: "page.html",
                    mimeType: "text/html",
                    size: 10,
                    createdAt: "2026-02-01",
                  },
                  {
                    id: "old",
                    name: "archive.zip",
                    mimeType: "application/zip",
                    size: 20,
                    createdAt: "2026-01-01",
                  },
                ],
          );

        if (failedDownload)
          return Response.json(
            { error: "Download unavailable" },
            { status: 503 },
          );

        return new Response("<script>bad()</script>", {
          headers: { "Content-Type": "text/html" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { Library } = await import("./library");
  const rootRoute = createRootRoute();

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <Library kind="bot" id="bot" />,
      }),
    ]),
  });

  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    await run(container, calls, blobs);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetchMock.mockRestore();
    Object.defineProperty(URL, "createObjectURL", urlOriginal.createObjectURL);
    Object.defineProperty(URL, "revokeObjectURL", urlOriginal.revokeObjectURL);

    for (const key of Object.keys(values)) {
      if (original[key]) Object.defineProperty(globalThis, key, original[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
}

test("library shows the empty state", async () => {
  await withLibrary(true, async (container) => {
    await waitFor(
      () =>
        container.textContent?.includes(
          "Files you send in this chat appear here.",
        ) === true,
    );
  });
});

test("library pages using the last file ID", async () => {
  await withLibrary(
    false,
    async (container, calls) => {
      await waitFor(
        () => container.textContent?.includes("file-49.zip") === true,
      );

      const more = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Load more",
      )!;

      await act(async () => more.click());
      await waitFor(
        () => container.textContent?.includes("older.zip") === true,
      );
      expect(calls.some((call) => call.includes("before=file-49"))).toBe(true);
    },
    true,
  );
});

test("library lists files, downloads safely and confirms deletion", async () => {
  await withLibrary(false, async (container, calls, blobs) => {
    await waitFor(
      () => container.textContent?.includes("archive.zip") === true,
    );
    expect(container.textContent.indexOf("page.html")).toBeLessThan(
      container.textContent.indexOf("archive.zip"),
    );

    const download = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Download",
    )!;

    await act(async () => download.click());
    await waitFor(() => blobs.length > 0);
    expect(blobs[0]!.type).toBe("application/octet-stream");

    const remove = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Delete",
    )!;

    await act(async () => {
      remove.dispatchEvent(
        new window.PointerEvent("pointerdown", {
          bubbles: true,
          button: 0,
          pointerType: "mouse",
        }),
      );
      remove.click();
    });
    expect(calls.some((call) => call.startsWith("DELETE"))).toBe(false);
    await waitFor(
      () => document.body.textContent?.includes("Delete page.html?") === true,
    );

    const confirm = document.body.querySelector<HTMLButtonElement>(
      '[data-slot="alert-dialog-action"]',
    )!;

    await act(async () => confirm.click());
    await waitFor(() => calls.some((call) => call.startsWith("DELETE")));
    await waitFor(
      () =>
        container.textContent?.includes(
          "Files you send in this chat appear here.",
        ) === true,
    );
  });
});
