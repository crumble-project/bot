import { expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { type ReactNode, act } from "react";
import { queryClient } from "@/lib/api";
import type { ChatSnapshot } from "./api";
import { defaultAvatarDefinition } from "@crumble/server/contract/avatar";

const GLOBALS = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "getComputedStyle",
  "matchMedia",
  "localStorage",
  "location",
  "IS_REACT_ACT_ENVIRONMENT",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "scrollTo",
  "Path2D",
];

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const bot = {
  id: "bot",
  name: "Bot",
  avatar: defaultAvatarDefinition("bot"),
  enabled: true,
  tools: [],
};

const owner = {
  id: "g:1:0",
  entryId: "g:1",
  role: "user",
  content: "The original",
};

const page = { messages: [owner], hasMore: false, oldestEntryId: "g:1" };

const groupSnapshot = {
  ...page,
  groupChat: { id: "g", name: "Group", memberIds: ["bot"] },
  activity: { members: [], paused: false },
};

/** Streams that never send: only their opening matters here. */
const silentStream = (signal: AbortSignal | null | undefined) =>
  new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.close());
      },
    }),
  );

type Answer = Response | ((init?: RequestInit) => Response);

/**
 * Renders `load`'s view at `path` in a happy-dom window, its API answering GETs from `answers`, and runs `check`.
 * `/` is the page a chat that is gone leaves for.
 */
async function render(
  path: string,
  answers: Map<string, Answer>,
  load: () => Promise<() => ReactNode>,
  check: (
    container: HTMLElement,
    router: { pathname: () => string; leave: () => Promise<void> },
  ) => Promise<void>,
) {
  const window = new Window({ url: "http://localhost" });
  const globals = Object.getOwnPropertyDescriptors(globalThis);

  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: Observer,
    IntersectionObserver: Observer,
    getComputedStyle: window.getComputedStyle.bind(window),
    matchMedia: window.matchMedia.bind(window),
    localStorage: window.localStorage,
    location: window.location,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    scrollTo: () => {},
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

  window.localStorage.setItem("crumble.details", "off");

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : input.toString();
        const answer = answers.get(url);

        if (url.endsWith("/events") && !answer)
          return silentStream(init?.signal);

        if (answer instanceof Response) return answer.clone();

        return answer?.(init) ?? new Response("down", { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const View = await load();
  const rootRoute = createRootRoute({ component: Outlet });

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [path] }),
    routeTree: rootRoute.addChildren([
      createRoute({
        getParentRoute: () => rootRoute,
        path: "/",
        component: () => <p>Home</p>,
      }),
      createRoute({
        getParentRoute: () => rootRoute,
        path: path,
        component: View,
      }),
    ]),
  });

  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <SidebarProvider>
            <TooltipProvider>
              <RouterProvider router={router} />
            </TooltipProvider>
          </SidebarProvider>
        </QueryClientProvider>,
      );
    });
    await settle();
    await settle();
    await check(container, {
      pathname: () => router.state.location.pathname,
      leave: () =>
        act(async () => {
          await router.navigate({ to: "/" });
        }),
    });
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();

    for (const key of GLOBALS) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
}

const loadGroup = async () => {
  const { GroupChatView } = await import("@/features/group-chats/groups");

  return () => <GroupChatView groupId="g" />;
};

const loadChat = async () => {
  const { Chat } = await import("@/features/bot-chat/chat");

  return () => <Chat botId="bot" />;
};

test("a group reply being sent shows what it answers", async () => {
  await render(
    "/groups/g",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      ["/v1/group-chats/g/chat", Response.json(groupSnapshot)],
    ]),
    loadGroup,
    async (container) => {
      const { deliver } = await import("./delivery");

      await act(async () => {
        await deliver("group:g", "/v1/group-chats/g/messages", {
          requestId: "request",
          content: "My answer",
          replyTo: "g:1",
          uploads: [],
        });
      });

      expect(container.textContent).toContain("My answer");
      expect(container.querySelector(".line-clamp-2")?.textContent).toBe(
        "The original",
      );
    },
  );
});

test("a deleted bot's open chat leaves for the home page", async () => {
  await render(
    "/bots/bot",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      [
        "/v1/agents/bot/chat",
        Response.json({
          ...page,
          status: "idle",
          error: null,
          partial: "",
        }),
      ],
      ["/v1/agents/bot/events", new Response("gone", { status: 404 })],
    ]),
    loadChat,
    async (container, { pathname }) => {
      await settle();
      expect(pathname()).toBe("/");
      expect(container.textContent).toContain("Home");
    },
  );
});

const chatSnapshot = (status: string, messages: unknown[] = page.messages) => ({
  ...page,
  messages,
  status,
  error: null,
  partial: "",
});

/** Answers an event stream that records the signal it follows until. */
const recordingStream =
  (signals: (AbortSignal | null | undefined)[]) => (init?: RequestInit) => {
    signals.push(init?.signal);

    return silentStream(init?.signal);
  };

test("a bot left while it works stays followed until it finishes", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];

  await render(
    "/bots/bot",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      ["/v1/agents/bot/chat", Response.json(chatSnapshot("running"))],
      ["/v1/agents/bot/events", recordingStream(signals)],
    ]),
    loadChat,
    async (_container, { leave }) => {
      const { chatQuery } = await import("./api");

      await leave();
      expect(signals[0]?.aborted).toBe(false);

      await act(async () => {
        queryClient.setQueryData(
          chatQuery("bot").queryKey,
          // SAFETY: only the status of this partial snapshot is read.
          chatSnapshot("idle") as ChatSnapshot,
        );
      });
      expect(signals[0]?.aborted).toBe(true);
    },
  );
});

test("a group chat stops following once left", async () => {
  const signals: (AbortSignal | null | undefined)[] = [];

  await render(
    "/groups/g",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      ["/v1/group-chats/g/chat", Response.json(groupSnapshot)],
      ["/v1/group-chats/g/events", recordingStream(signals)],
    ]),
    loadGroup,
    async (_container, { leave }) => {
      expect(signals[0]?.aborted).toBe(false);
      await leave();
      expect(signals[0]?.aborted).toBe(true);
    },
  );
});

const jobResult = (id: number, toolName: string) => ({
  id: `bot:${id}:0`,
  entryId: `bot:${id}`,
  role: "toolResult",
  content: "",
  toolName,
  toolDetails: { name: "build", status: "idle" },
});

test("job messages refetch the job list, and a card reads its own kind's job", async () => {
  let reads = 0;

  await render(
    "/bots/bot",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      [
        "/v1/agents/bot/chat",
        Response.json(
          chatSnapshot("idle", [
            jobResult(1, "coding"),
            jobResult(2, "desktop"),
          ]),
        ),
      ],
      [
        "/v1/agents/bot/coding-jobs",
        () => {
          reads++;

          return Response.json({
            jobs: [{ name: "build", status: "working" }],
          });
        },
      ],
      [
        "/v1/agents/bot/desktop-jobs",
        Response.json({ jobs: [{ name: "build", status: "idle" }] }),
      ],
    ]),
    loadChat,
    async (container) => {
      const { chatQuery } = await import("./api");
      const before = reads;

      expect(before).toBeGreaterThan(0);
      expect(container.textContent).toContain("Coding jobWorking");
      expect(container.textContent).toContain("Desktop jobIdle");

      await act(async () => {
        queryClient.setQueryData(
          chatQuery("bot").queryKey,
          // SAFETY: only the messages of this partial snapshot are read.
          chatSnapshot("idle", [
            jobResult(1, "coding"),
            jobResult(2, "desktop"),
            jobResult(3, "coding"),
          ]) as ChatSnapshot,
        );
      });
      await settle();

      expect(reads).toBe(before + 1);
    },
  );
});
