import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { act } from "react";
import { z } from "zod";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";
import type { ReplyReference } from "@crumble/server/contract/push";
import { queryClient } from "@/lib/api";
import { settle, waitFor } from "@/test/wait-for";

type RequestState = {
  failSeen: boolean;
  heldView?: ReturnType<typeof Promise.withResolvers<Response>>;
  answers?: Map<string, Promise<Response>>;
};

function recordRequests(credentials: Promise<Response>) {
  const requests: { path: string; body: unknown }[] = [];
  const state: RequestState = { failSeen: false };

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (path === "/v1/agents/bot/credentials") return credentials;
        const answer = state.answers?.get(path);

        if (answer) return answer;

        if (init?.method !== "PUT" && init?.method !== "POST")
          return new Response("unexpected request", { status: 500 });

        const body: unknown = JSON.parse(z.string().parse(init.body));
        requests.push({ path, body });

        if (path === "/v1/chat-attention/seen" && state.failSeen) {
          state.failSeen = false;

          return new Response("retry", { status: 503 });
        }

        if (init.method === "PUT" && state.heldView) {
          const response = state.heldView;
          delete state.heldView;

          return response.promise;
        }

        return new Response(null, { status: 204 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  return { requests, state, fetch };
}

async function checkChatLoadingGate(
  state: RequestState,
  requests: { path: string; body: unknown }[],
) {
  queryClient.clear();
  const bots = Promise.withResolvers<Response>();

  const snapshot = {
    messages: [
      {
        id: "bot:1:0",
        entryId: "bot:1",
        role: "user",
        content: "Loaded snapshot",
        replyReferences: [],
      },
    ],
    hasMore: false,
    oldestEntryId: "bot:1",
    status: "idle",
    working: "idle",
    error: null,
    partial: "",
  };

  state.answers = new Map([
    ["/v1/agents", bots.promise],
    ["/v1/agents/bot/chat", Promise.resolve(Response.json(snapshot))],
    [
      "/v1/agents/bot/events",
      Promise.resolve(new Response(new ReadableStream())),
    ],
  ]);
  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { Chat } = await import("@/features/bot-chat/chat");
  const { chatQuery } = await import("@/features/chat/api");
  const route = createRootRoute({ component: Outlet });

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/bots/bot"] }),
    routeTree: route.addChildren([
      createRoute({
        getParentRoute: () => route,
        path: "/bots/bot",
        component: () => <Chat botId="bot" />,
      }),
    ]),
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  const views = () =>
    requests.filter(({ path }) => path.startsWith("/v1/chat-attention/views/"));

  const before = views().length;
  localStorage.setItem("crumble.details", "off");

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </SidebarProvider>
        </QueryClientProvider>,
      ),
    );
    await waitFor(
      () => queryClient.getQueryData(chatQuery("bot").queryKey) !== undefined,
      "snapshot before bot list",
    );
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
    await settle();
    expect(views()).toHaveLength(before);
    await act(async () =>
      bots.resolve(
        Response.json([
          {
            id: "bot",
            name: "Bot",
            avatar: defaultAvatarDefinition("bot"),
            enabled: true,
            tools: [],
          },
        ]),
      ),
    );
    await waitFor(
      () => container.textContent?.includes("Loaded snapshot") === true,
      "mounted chat",
    );
    await waitFor(() => views().length > before, "active view");
    expect(views()[before]!.body).toEqual({ chat: { kind: "bot", id: "bot" } });
    await act(async () => root.render(null));
    await waitFor(() => views().length > before + 1, "cleared view");
    expect(views()[before + 1]!.body).toEqual({ chat: null });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    delete state.answers;
  }
}

test("reports only active views and ready visible reply surfaces", async () => {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);
  let focused = true;
  let visible = true;
  const observers = new Map<Element, IntersectionObserverCallback>();

  class Observer {
    private elements = new Set<Element>();
    constructor(private callback: IntersectionObserverCallback) {}
    observe(element: Element) {
      observers.set(element, this.callback);
      this.elements.add(element);
    }
    unobserve(element: Element) {
      observers.delete(element);
    }
    disconnect() {
      for (const element of this.elements) observers.delete(element);
    }
  }

  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    matchMedia: window.matchMedia.bind(window),
    localStorage: window.localStorage,
    location: window.location,
    scrollTo: () => {},
    IntersectionObserver: Observer,
    getComputedStyle: window.getComputedStyle.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
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
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => focused,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });

  const intervals = new Map<number, () => void>();
  let nextInterval = 0;

  // SAFETY: The controller only schedules no-argument heartbeat callbacks.
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    if (delay !== 30_000) throw new Error(`Unexpected interval ${delay}`);
    const id = ++nextInterval;
    intervals.set(id, callback);

    return id;
  }) as typeof setInterval);

  // SAFETY: This mock only receives the numeric handles returned above.
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((
    id: number,
  ) => {
    intervals.delete(id);
  }) as typeof clearInterval);

  let resolveCredentials: (response: Response) => void = () => {};

  const credentials = new Promise<Response>((resolve) => {
    resolveCredentials = resolve;
  });

  const { requests, state, fetch } = recordRequests(credentials);
  const retryCallbacks: (() => void)[] = [];
  const retryHandles: ReturnType<typeof setTimeout>[] = [];
  const nativeTimeout = globalThis.setTimeout;

  // SAFETY: The tested timers use no-argument callbacks and no extra arguments.
  const timeout = spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: () => void,
    delay?: number,
  ) => {
    if (delay !== 1000) return nativeTimeout(callback, delay);
    retryCallbacks.push(callback);
    const handle = nativeTimeout(() => {}, 60_000);
    retryHandles.push(handle);

    return handle;
  }) as typeof setTimeout);

  const { createRoot } = await import("react-dom/client");

  const { createChatAttention, getChatAttention } =
    await import("@/lib/chat-attention");

  const { resetSession } = await import("@/lib/session");

  const { ReplyAttention, AttentionChatContext, selectAttentionChat } =
    await import("@/features/chat/reply-attention");

  const { credentialRequestResult } =
    await import("@/features/credentials/credential-request");

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const text = document.createElement("div");
  text.textContent = "Mixed reply text";
  document.body.append(text);
  const controller = getChatAttention();
  const bot = { kind: "bot", id: "bot" } as const;
  const group = { kind: "group", id: "group" } as const;

  const reference: ReplyReference = {
    eventId: "card-event",
    surface: { kind: "tool-card", toolCallId: "call" },
  };

  const request = {
    name: "TOKEN",
    hosts: ["example.com"],
    reason: "Needed",
    requestedAt: "2026-10-30T11:00:00.000Z",
  };

  const card = credentialRequestResult({
    id: "m",
    entryId: "e",
    role: "toolResult",
    content: "",
    toolName: "request_credential",
    toolCallId: "call",
    toolDetails: request,
    replyReferences: [reference],
  });

  if (!card) throw new Error("Expected credential card");

  const chat = {
    botId: "bot",
    botName: "Bot",
    attachmentPath: () => "",
    jobStatus: () => undefined,
    onOpenJob: () => {},
    onOpenCall: () => {},
  };

  const seen = () =>
    requests.filter(({ path }) => path === "/v1/chat-attention/seen");

  const views = () =>
    requests.filter(({ path }) => path.startsWith("/v1/chat-attention/views/"));

  const intersect = (element: Element, isIntersecting: boolean) => {
    const callback = observers.get(element);

    if (!callback) throw new Error("Expected observed element");
    // SAFETY: The boundary reads only these entry fields and ignores the observer.
    callback(
      [
        {
          target: element,
          isIntersecting,
          intersectionRatio: isIntersecting ? 1 : 0,
        } as IntersectionObserverEntry,
      ],
      {} as IntersectionObserver,
    );
  };

  try {
    selectAttentionChat("bot:bot");
    controller.setChat(bot);
    await waitFor(() => views().length === 1);
    expect(views()[0]!.body).toEqual({ chat: bot });
    expect(intervals.size).toBe(1);
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <AttentionChatContext.Provider value="bot:bot">
            <ReplyAttention
              controller={controller}
              references={[]}
              ready
              element={text}
            />
            {card(chat)}
          </AttentionChatContext.Provider>
        </QueryClientProvider>,
      );
    });
    await waitFor(() => container.textContent?.includes("Loading") === true);
    await waitFor(() => observers.size > 0);
    expect(observers.has(text)).toBe(false);
    let element = [...observers.keys()].find((item) => item !== text)!;
    await act(async () => intersect(element, true));
    await settle();
    expect(seen()).toEqual([]);
    await act(async () => intersect(element, false));
    await act(async () => {
      resolveCredentials(
        Response.json({ credentials: [], requests: [request] }),
      );
    });
    await waitFor(
      () => container.textContent?.includes("Add credential") === true,
    );
    await waitFor(() => [...observers.keys()].some((item) => item !== text));
    element = [...observers.keys()].find((item) => item !== text)!;
    await act(async () => intersect(element, false));
    await settle();
    expect(seen()).toEqual([]);
    focused = false;
    await act(async () => window.dispatchEvent(new window.Event("blur")));
    await waitFor(() => views().length === 2);
    expect(views()[1]!.body).toEqual({ chat: null });
    expect(intervals.size).toBe(0);
    await act(async () => intersect(element, true));
    await settle();
    expect(seen()).toEqual([]);
    focused = true;
    await act(async () => window.dispatchEvent(new window.Event("focus")));
    await waitFor(() => views().length === 3 && seen().length === 1);
    expect(views()[2]!.body).toEqual({ chat: bot });
    expect(seen()[0]?.body).toEqual({ chat: bot, eventIds: ["card-event"] });
    await act(async () => {
      for (const callback of intervals.values()) callback();
    });
    await waitFor(() => views().length === 4);
    expect(views()[3]!.body).toEqual({ chat: bot });
    visible = false;
    await act(async () =>
      window.document.dispatchEvent(new window.Event("visibilitychange")),
    );
    await waitFor(() => views().length === 5);
    expect(views()[4]!.body).toEqual({ chat: null });
    expect(intervals.size).toBe(0);
    visible = true;
    await act(async () =>
      window.document.dispatchEvent(new window.Event("visibilitychange")),
    );
    await waitFor(() => views().length === 6);
    expect(views()[5]!.body).toEqual({ chat: bot });
    controller.displayed({ eventId: "old", surface: { kind: "text" } });
    controller.setChat(group);
    await waitFor(() => views().length === 7);
    await settle();
    expect(seen()).toHaveLength(1);
    expect(views()[6]!.body).toEqual({ chat: group });
    controller.displayed({ eventId: "other", surface: { kind: "text" } });
    controller.setChat(null);
    await waitFor(() => views().length === 8);
    await settle();
    expect(seen()).toHaveLength(1);
    expect(views()[7]!.body).toEqual({ chat: null });

    const serial = createChatAttention();
    const delayed = Promise.withResolvers<Response>();
    state.heldView = delayed;
    serial.setChat(bot);
    await waitFor(() => views().length === 9);
    const serialPath = views()[8]!.path;
    const serialViews = () => views().filter(({ path }) => path === serialPath);

    for (const callback of intervals.values()) callback();
    focused = false;
    window.dispatchEvent(new window.Event("blur"));
    delayed.resolve(new Response(null, { status: 204 }));
    await waitFor(() => serialViews().length === 2);
    await settle();
    expect(serialViews()).toHaveLength(2);
    expect(serialViews()[1]?.body).toEqual({ chat: null });
    serial.dispose();
    focused = true;

    const retrying = createChatAttention();
    retrying.setChat(bot);
    state.failSeen = true;
    retrying.displayed({ eventId: "retry", surface: { kind: "text" } });
    await waitFor(() => seen().length === 2 && retryCallbacks.length === 1);
    retrying.setChat(group);
    retryCallbacks.at(-1)!();
    await waitFor(() => seen().length === 3);
    expect(seen()[1]?.body).toEqual({ chat: bot, eventIds: ["retry"] });
    expect(seen()[2]?.body).toEqual(seen()[1]?.body);
    state.failSeen = true;
    const retriesBeforeReset = retryCallbacks.length;
    retrying.displayed({ eventId: "old-account", surface: { kind: "text" } });
    await waitFor(
      () => seen().length === 4 && retryCallbacks.length > retriesBeforeReset,
    );
    const pendingRetry = retryCallbacks.at(-1)!;
    resetSession();
    const attempts = requests.length;
    pendingRetry();
    await settle();
    expect(requests).toHaveLength(attempts);
    expect(seen()).toHaveLength(4);
    const second = createChatAttention();
    second.setChat(bot);
    second.displayed({ eventId: "disposed", surface: { kind: "text" } });
    second.dispose();
    resetSession();
    await settle();
    expect(seen()).toHaveLength(4);
    expect(intervals.size).toBe(0);
    await checkChatLoadingGate(state, requests);
  } finally {
    await act(async () => root.unmount());
    controller.dispose();
    selectAttentionChat(null);
    resetSession();
    queryClient.clear();
    fetch.mockRestore();
    interval.mockRestore();
    clear.mockRestore();

    for (const handle of retryHandles) clearTimeout(handle);
    timeout.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
});
