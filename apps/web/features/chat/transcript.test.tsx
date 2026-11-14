import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Suspense, act, startTransition } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Message } from "./api";
import {
  ARRIVAL,
  AttachmentImage,
  Attachments,
  mergeMessages,
  useArrivals,
} from "./transcript";
import type { CardChat } from "./message-card";
import { shownInChat, ToolResultRow } from "@/features/bot-chat/chat-cards";

const message = (id: string): Message => ({
  id,
  entryId: id,
  role: "assistant",
  content: "",
  replyReferences: [],
});

const pending = new Promise<never>(() => {});

const chat: CardChat = {
  botId: "bot",
  botName: "Ada",
  attachmentPath: () => "/screen",
  jobStatus: () => {},
  onOpenJob: () => {},
  onOpenCall: () => {},
};

test("deleted files remain visible in the transcript", () => {
  const owner: Message = {
    ...message("owner"),
    role: "user",
    files: [{ id: "deleted", deleted: true }],
  };

  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Attachments message={owner} filePath={() => ""} />
    </QueryClientProvider>,
  );

  expect(html).toContain("File deleted");
});

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

  const render = (path: string) => (
    <QueryClientProvider client={client}>
      <AttachmentImage path={path} name="image.png" />
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
    Object.defineProperty(URL, "createObjectURL", urlMethods.createObjectURL);
    Object.defineProperty(URL, "revokeObjectURL", urlMethods.revokeObjectURL);

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

test("a desktop screenshot shows its entry's first image; a refused one shows nothing", async () => {
  const window = new Window();
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  const urlMethods = Object.getOwnPropertyDescriptors(URL);
  const client = new QueryClient();
  const paths: string[] = [];

  const screenshot: Message = {
    ...message("bot:7"),
    role: "toolResult",
    content: "Shown to the owner.",
    toolName: "desktop_screenshot",
    toolDetails: { mimeType: "image/jpeg", size: 4 },
  };

  const refused: Message = { ...screenshot, isError: true };

  expect(shownInChat(screenshot)).toBe(true);
  expect(shownInChat(refused)).toBe(false);

  Object.defineProperties(globalThis, {
    window: { configurable: true, value: window },
    document: { configurable: true, value: window.document },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  URL.createObjectURL = () => "blob:screen";
  URL.revokeObjectURL = () => {};

  client.setQueryData(["attachment", "/screen"], new Blob(["jpeg"]));

  const container = document.createElement("div");
  const root = createRoot(container);

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ToolResultRow
            message={screenshot}
            chat={{
              ...chat,
              attachmentPath: (entryId, index) => {
                paths.push(`${entryId}/${index}`);

                return "/screen";
              },
            }}
          />
        </QueryClientProvider>,
      ),
    );

    expect(paths).toContain("bot:7/0");
    expect(container.querySelector("img")?.getAttribute("alt")).toBe(
      "Desktop screenshot",
    );

    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <ToolResultRow message={refused} chat={chat} />
        </QueryClientProvider>,
      ),
    );

    expect(container.querySelector("img")).toBeNull();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    Object.defineProperty(URL, "createObjectURL", urlMethods.createObjectURL);
    Object.defineProperty(URL, "revokeObjectURL", urlMethods.revokeObjectURL);

    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});

const show = (toolDetails: Message["toolDetails"]): Message => ({
  ...message("show:1"),
  role: "toolResult",
  toolName: "show",
  toolDetails,
});

test("a stored chart keeps its compiled layouts; details that don't parse show nothing", () => {
  const layouts = [{ width: 320, height: 200, nodes: [], points: [{ x: 1 }] }];

  expect(shownInChat(show({ kind: "chart", layouts }))).toBe(true);
  expect(shownInChat(show({ kind: "chart", layouts: [{}] }))).toBe(false);
  expect(shownInChat(show({ kind: "stats" }))).toBe(false);
});

test("older pages stay before the live page, and a message in both shows once", () => {
  const ids = mergeMessages(
    [message("bot:1:0"), message("bot:9:0"), message("bot:10:0")],
    [message("bot:10:0"), message("bot:10:1"), message("bot:11:0")],
  ).map(({ id }) => id);

  expect(ids).toEqual([
    "bot:1:0",
    "bot:9:0",
    "bot:10:0",
    "bot:10:1",
    "bot:11:0",
  ]);
});
