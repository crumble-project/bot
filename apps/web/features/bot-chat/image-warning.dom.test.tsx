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
import { settle, waitFor, waitForIdle } from "@/test/wait-for";
import type { Upload } from "@/features/chat/composer";
import { ImageWarning } from "./image-warning";

const bot = { id: "b1", name: "Atlas", provider: "p", model: "flash" };

const image: Upload = {
  name: "photo.png",
  mimeType: "image/png",
  size: 1024,
  status: "ready",
  id: "f1",
};

const largeImage: Upload = { ...image, size: 6 * 1024 * 1024 };

const text: Upload = { ...image, name: "notes.txt", mimeType: "text/plain" };

async function render(
  uploads: Array<Upload>,
  { images = false, vision = false } = {},
) {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    HTMLElement: { configurable: true, value: window.HTMLElement },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL) => {
        const url = z.string().parse(input);

        if (url.startsWith("/v1/models")) {
          return Response.json([
            {
              provider: "p",
              id: "flash",
              name: "Flash",
              contextWindow: 1000,
              reasoning: false,
              thinkingLevels: [],
              images,
            },
          ]);
        }

        return Response.json({
          visionModel: vision ? { provider: "p", model: "eyes" } : null,
          choices: [],
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const router = createRouter({ routeTree: createRootRoute() });
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <RouterContextProvider router={router}>
          <ImageWarning bot={bot} uploads={uploads} />
        </RouterContextProvider>
      </QueryClientProvider>,
    );
  });
  await waitForIdle(client);
  await settle();

  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      client.clear();
      fetch.mockRestore();
      await window.happyDOM.abort();
      Object.defineProperties(globalThis, globals);
    },
  };
}

test("warns about an attached image the bot's model can't read, naming the bot", async () => {
  const { container, cleanup } = await render([text, image]);

  try {
    await waitFor(() => container.querySelector("[role=alert]") !== null);
    expect(container.textContent).toContain(
      "Atlas's model (flash) can't read images.",
    );
    expect(
      [...container.querySelectorAll("a")].map((link) =>
        link.getAttribute("href"),
      ),
    ).toEqual(["/bots/b1/edit", "/settings/vision-model"]);
  } finally {
    await cleanup();
  }
});

for (const [name, uploads, options] of [
  ["the model reads images", [image], { images: true }],
  ["a vision model describes images", [image], { vision: true }],
  ["no image is attached", [text], {}],
  ["the image is sent as a file reference", [largeImage], {}],
] as const) {
  test(`stays quiet when ${name}`, async () => {
    const { container, cleanup } = await render([...uploads], options);

    try {
      expect(container.querySelector("[role=alert]")).toBeNull();
    } finally {
      await cleanup();
    }
  });
}
