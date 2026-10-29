import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, act, startTransition } from "react";
import { createRoot } from "react-dom/client";
import type { Message } from "@/lib/api";
import { ARRIVAL, Attachments, useArrivals } from "./transcript";

const message = (id: string): Message => ({
  id,
  entryId: id,
  role: "assistant",
  content: "",
});

const pending = new Promise<never>(() => {});

test("attachment image URLs follow replacement and unmount", async () => {
  const window = new Window();
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  const urlMethods = Object.getOwnPropertyDescriptors(URL);
  const created: (Blob | MediaSource)[] = [];
  const revoked: string[] = [];
  const first = new Blob(["first"]);
  const second = new Blob(["second"]);
  const client = new QueryClient();

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  URL.createObjectURL = (blob) => {
    created.push(blob);

    return `blob:test-${created.length}`;
  };

  URL.revokeObjectURL = (url) => revoked.push(url);
  client.setQueryData(["attachment", "/first"], first);
  client.setQueryData(["attachment", "/second"], second);

  const container = document.createElement("div");
  const root = createRoot(container);

  const attachmentMessage: Message = {
    ...message("owner"),
    role: "user",
    attachments: [
      { name: "image.png", mimeType: "image/png", size: 1, kind: "image" },
    ],
  };

  const render = (path: string) => (
    <QueryClientProvider client={client}>
      <Attachments message={attachmentMessage} attachmentPath={() => path} />
    </QueryClientProvider>
  );

  try {
    await act(async () => root.render(render("/first")));

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:test-1",
    );
    expect(created).toEqual([first]);
    expect(revoked).toEqual([]);

    await act(async () => root.render(render("/second")));

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "blob:test-2",
    );
    expect(created).toEqual([first, second]);
    expect(revoked).toEqual(["blob:test-1"]);

    await act(async () => root.unmount());

    expect(revoked).toEqual(["blob:test-1", "blob:test-2"]);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    Object.defineProperty(URL, "createObjectURL", urlMethods.createObjectURL!);
    Object.defineProperty(URL, "revokeObjectURL", urlMethods.revokeObjectURL!);

    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});

test("discarded initial history does not mark committed history as new", async () => {
  const window = new Window();
  const globals = Object.getOwnPropertyDescriptors(globalThis);

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  let latest: ReturnType<typeof useArrivals> | undefined;

  function Transcript({
    live,
    suspend,
  }: {
    live?: Message[];
    suspend?: boolean;
  }) {
    const arrivals = useArrivals(live);

    if (suspend) throw pending;

    latest = arrivals;

    return null;
  }

  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <Suspense fallback={null}>
          <Transcript />
        </Suspense>,
      ),
    );
    await act(async () => {
      startTransition(() =>
        root.render(
          <Suspense fallback={null}>
            <Transcript live={[message("discarded")]} suspend />
          </Suspense>,
        ),
      );
    });
    await act(async () =>
      root.render(
        <Suspense fallback={null}>
          <Transcript live={[message("history")]} />
        </Suspense>,
      ),
    );

    expect(latest?.arrival(message("history"))).toBeUndefined();
    expect(latest?.arrival(message("new"))).toBe(ARRIVAL);
    expect(
      latest?.arrival({
        ...message("owner"),
        role: "user",
        requestId: "request",
      }),
    ).toBeUndefined();

    await act(async () => latest?.remember([message("older")]));

    expect(latest?.arrival(message("older"))).toBeUndefined();
    expect(latest?.arrival(message("new"))).toBe(ARRIVAL);
  } finally {
    await act(async () => root.unmount());

    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
