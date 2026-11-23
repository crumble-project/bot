import { agentFixture } from "@/test/agent-fixture";
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
import { act } from "react";
import type { ReactNode } from "react";
import { queryClient } from "@/lib/api";
import { settle, waitFor, waitForIdle } from "@/test/wait-for";
import type { ChatSnapshot, Message } from "./api";
import { requestPath } from "@/test/request-path";

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

const bot = agentFixture({ id: "bot", name: "Bot" });

const owner = {
  id: "bot:1:0",
  entryId: "bot:1",
  role: "user",
  content: "The original",
  replyReferences: [],
};

const page: ChatSnapshot = {
  messages: [owner],
  hasMore: false,
  oldestEntryId: "bot:1",
  conversationId: "bot:bot",
  agentId: "bot",
  conversation: {
    id: "bot:bot",
    agentId: "bot",
    title: "Bot",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  partial: "",
  status: "idle",
  working: "idle",
  updatedAt: 0,
  error: null,
};

const silentStream = (signal: AbortSignal | null | undefined) =>
  new Response(
    new ReadableStream({
      start(controller) {
        signal?.addEventListener("abort", () => controller.close());
      },
    }),
  );

type Answer = Response | ((init?: RequestInit) => Response);

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

  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }

  window.localStorage.setItem("crumble.details", "off");

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = requestPath(input);
        const answer = answers.get(url);

        if (url.endsWith("/events") && !answer) {
          return silentStream(init?.signal);
        }

        if (answer && typeof answer !== "function") {
          return answer.clone();
        }

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
        path,
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
    await check(container, {
      pathname: () => router.state.location.pathname,
      leave: () =>
        act(async () => {
          await router.navigate({ to: "/" });
        }),
    });
    await waitForIdle(queryClient);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();

    for (const key of GLOBALS) {
      if (globals[key]) {
        Object.defineProperty(globalThis, key, globals[key]);
      } else {
        Reflect.deleteProperty(globalThis, key);
      }
    }

    window.close();
  }
}

const shows = (container: HTMLElement, text: string) => () =>
  container.textContent?.includes(text) === true;

const loadChat = async () => {
  const { Chat } = await import("@/features/bot-chat/chat");
  const botId = "bot";
  const ChatView = () => <Chat botId={botId} />;

  return ChatView;
};

test("a bot reply being sent shows what it answers", async () => {
  await render(
    "/bots/bot",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      ["/v1/agents/bot/chat", Response.json(chatSnapshot("idle"))],
    ]),
    loadChat,
    async (container) => {
      const { deliver, discard } = await import("./delivery");

      await waitFor(shows(container, "The original"));
      await act(async () => {
        await deliver("bot:bot", "/v1/agents/bot/messages", {
          requestId: "request",
          content: "My answer",
          replyTo: "bot:1",
          uploads: [],
        });
      });

      expect(container.textContent).toContain("My answer");
      // Once as its own message and once quoted above the reply.
      expect(container.textContent?.split("The original")).toHaveLength(3);

      await act(async () => discard("bot:bot", "request"));
    },
  );
});

async function sendInChat(container: HTMLElement, text: string) {
  const field = container.querySelector("textarea")!;

  await act(async () => {
    Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set?.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    container
      .querySelector("form")!
      .dispatchEvent(
        new window.Event("submit", { bubbles: true, cancelable: true }),
      );
  });
}

test("a message the server refused goes back to the composer and leaves the transcript", async () => {
  await render(
    "/bots/bot",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      ["/v1/agents/bot/chat", Response.json(chatSnapshot("idle"))],
      [
        "/v1/agents/bot/messages",
        Response.json({ error: "Too long" }, { status: 400 }),
      ],
    ]),
    loadChat,
    async (container) => {
      await waitFor(shows(container, "The original"));
      await sendInChat(container, "Refused");

      await waitFor(shows(container, "Too long"));
      expect(container.querySelector("textarea")!.value).toBe("Refused");
      expect(container.textContent).not.toContain("Not sent");
    },
  );
});

test("a message that may have arrived stays for Retry, and the composer stays empty", async () => {
  await render(
    "/bots/bot",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      ["/v1/agents/bot/chat", Response.json(chatSnapshot("idle"))],
      [
        "/v1/agents/bot/messages",
        Response.json({ error: "Bad gateway" }, { status: 502 }),
      ],
    ]),
    loadChat,
    async (container) => {
      await waitFor(shows(container, "The original"));
      await sendInChat(container, "Maybe arrived");

      await waitFor(shows(container, "Maybe arrivedNot sent"));
      expect(container.querySelector("textarea")!.value).toBe("");
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
          working: "idle",
          error: null,
          partial: "",
        }),
      ],
      ["/v1/agents/bot/events", new Response("gone", { status: 404 })],
    ]),
    loadChat,
    async (container, { pathname }) => {
      await waitFor(() => pathname() === "/", "the home page");
      expect(container.textContent).toContain("Home");
    },
  );
});

const chatSnapshot = (
  status: ChatSnapshot["status"],
  messages: Array<Message> = page.messages,
): ChatSnapshot => ({
  ...page,
  messages,
  status,
  working: status === "running" ? "thinking" : "idle",
  error: null,
  partial: "",
});

const recordingStream =
  (signals: Array<AbortSignal | null | undefined>) => (init?: RequestInit) => {
    signals.push(init?.signal);

    return silentStream(init?.signal);
  };

test("a bot left while it works stays followed until it finishes", async () => {
  const signals: Array<AbortSignal | null | undefined> = [];

  await render(
    "/bots/bot",
    new Map<string, Answer>([
      ["/v1/agents", Response.json([bot])],
      ["/v1/agents/bot/chat", Response.json(chatSnapshot("running"))],
      ["/v1/agents/bot/events", recordingStream(signals)],
    ]),
    loadChat,
    async (container, { leave }) => {
      const { chatQuery } = await import("./api");

      await waitFor(shows(container, "The original"));
      await waitFor(() => signals.length > 0, "the event stream");
      await leave();
      expect(signals[0]?.aborted).toBe(false);

      await act(async () => {
        queryClient.setQueryData(
          chatQuery("bot").queryKey,
          chatSnapshot("idle"),
        );
      });
      await waitFor(() => signals[0]?.aborted === true, "the stream to stop");
    },
  );
});

const jobResult = (id: number, toolName: string) => ({
  id: `bot:${id}:0`,
  entryId: `bot:${id}`,
  role: "toolResult",
  content: "",
  replyReferences: [],
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
            jobs: [
              {
                name: "build",
                conversationId: "coding:build",
                status: "working",
              },
            ],
          });
        },
      ],
      [
        "/v1/agents/bot/desktop-jobs",
        Response.json({
          jobs: [
            { name: "build", conversationId: "desktop:build", status: "idle" },
          ],
        }),
      ],
    ]),
    loadChat,
    async (container) => {
      const { chatQuery } = await import("./api");

      await waitFor(shows(container, "Coding jobWorking"));
      await waitFor(shows(container, "Desktop jobIdle"));

      const before = reads;

      await act(async () => {
        queryClient.setQueryData(
          chatQuery("bot").queryKey,
          chatSnapshot("idle", [
            jobResult(1, "coding"),
            jobResult(2, "desktop"),
            jobResult(3, "coding"),
          ]),
        );
      });
      await waitFor(() => reads > before, "the job list to refetch");
      await settle();

      expect(reads).toBe(before + 1);
    },
  );
});
