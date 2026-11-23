import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { z } from "zod";
import type { Bot } from "@/features/bots/api";
import { agentFixture } from "@/test/agent-fixture";
import { defined } from "@/test/defined";
import { requestPath } from "@/test/request-path";
import { settle, waitFor } from "@/test/wait-for";

const window = new Window({ url: "http://localhost" });
const globals = Object.getOwnPropertyDescriptors(globalThis);

const values = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  localStorage: window.localStorage,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  MutationObserver: window.MutationObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  DOMRect: window.DOMRect,
  scrollTo: () => {},
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
};

const BOTS = [
  { id: "juniper", name: "Juniper", status: "question" },
  { id: "moss", name: "Moss", status: "idle" },
  { id: "fern", name: "Fern", status: "working" },
  { id: "ash", name: "Ash", status: "idle" },
  { id: "birch", name: "Birch", status: "thinking" },
] satisfies Array<Pick<Bot, "id" | "name" | "status">>;

let stored: Array<string> = [];
let written: Array<Array<string>> = [];
let events: ReadableStreamDefaultController<Uint8Array> | undefined;
let root: Root;
let container: HTMLElement;
let controller: AbortController;
let notifySession: () => void;
let fetch: ReturnType<typeof stubServer>;

const stubServer = () =>
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = requestPath(input);

        if (path === "/v1/agents") {
          return Response.json(BOTS.map((bot) => agentFixture(bot)));
        }

        if (path === "/v1/events") {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(stream) {
                events = stream;
              },
            }),
          );
        }

        if (path.endsWith("/update-user")) {
          const body = z
            .object({ pinnedConversations: z.array(z.string()) })
            .parse(JSON.parse(z.string().parse(init?.body)));

          written.push(body.pinnedConversations);
          stored = body.pinnedConversations;

          return Response.json({ status: true });
        }

        if (path.endsWith("/get-session")) {
          return Response.json({
            session: { id: "s", userId: "u" },
            user: { id: "u", pinnedConversations: stored },
          });
        }

        return new Response("unexpected request", { status: 500 });
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

const send = (name: string, data: unknown) =>
  act(async () =>
    events?.enqueue(
      new TextEncoder().encode(
        `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
      ),
    ),
  );

const row = (name: string) =>
  defined(
    container.querySelector<HTMLAnchorElement>(`a[aria-label^="${name}"]`),
    `the ${name} link`,
  );

const avatarOf = (name: string) =>
  defined(
    row(name).querySelector("[data-state]"),
    `${name}'s avatar`,
  ).getAttribute("data-state");

const labels = () =>
  [...container.querySelectorAll("a[aria-label]")].map((link) =>
    link.getAttribute("aria-label"),
  );

const follows = (first: Element, second: Element) =>
  Boolean(
    first.compareDocumentPosition(second) &
    window.Node.DOCUMENT_POSITION_FOLLOWING,
  );

const press = (element: Element, ...types: Array<string>) =>
  act(async () => {
    for (const type of types) {
      element.dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          button: 0,
        }),
      );
    }
  });

const menuItem = (name: string) =>
  [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === name,
  );

beforeAll(async () => {
  fetch = stubServer();

  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
});

beforeEach(async () => {
  stored = ["agent:juniper", "agent:moss"];
  written = [];
  events = undefined;

  const { createRoot } = await import("react-dom/client");
  const { SidebarProvider } = await import("@/components/ui/sidebar");
  const { botsQuery } = await import("@/features/bots/api");
  const { queryClient } = await import("@/lib/api");
  const { usePins } = await import("@/lib/pins");
  const { authClient } = await import("@/lib/auth-client");
  const { followActivity } = await import("./activity-stream");
  const { AppSidebar } = await import("./sidebar");

  queryClient.clear();
  notifySession = () => authClient.$store.notify("$sessionSignal");

  function Harness() {
    const bots = useQuery(botsQuery);
    const pins = usePins(bots.data);

    return <AppSidebar bots={bots} pins={pins} onSearch={() => {}} />;
  }

  const rootRoute = createRootRoute({
    component: () => (
      <SidebarProvider>
        <Harness />
        <Outlet />
      </SidebarProvider>
    ),
  });

  const pages = [
    "/bots/$botId",
    "/bots/new",
    "/automations",
    "/activity",
    "/settings",
  ];

  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/bots/ash"] }),
    routeTree: rootRoute.addChildren(
      pages.map((path) =>
        createRoute({
          getParentRoute: () => rootRoute,
          path,
          component: () => null,
        }),
      ),
    ),
  });

  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );

  controller = new AbortController();

  followActivity(
    { open: () => {}, pathOf: ({ id }) => `/bots/${id}` },
    controller.signal,
  );

  await act(async () => notifySession());
  await waitFor(() => labels().length >= BOTS.length, "the bots");
  await waitFor(() => events !== undefined, "the event stream");
});

afterEach(async () => {
  controller.abort();
  await act(async () => root.unmount());
  container.remove();
});

afterAll(() => {
  fetch.mockRestore();

  for (const key of Object.keys(values)) {
    if (globals[key]) {
      Object.defineProperty(globalThis, key, globals[key]);
    } else {
      Reflect.deleteProperty(globalThis, key);
    }
  }

  window.close();
});

test("lists the pins, then Automations, then the other bots", () => {
  const pins = defined(
    container.querySelector('[aria-label="Pinned bots"]'),
    "the pins",
  );
  const automations = defined(
    container.querySelector('a[href="/automations"]'),
    "Automations",
  );
  const bots = defined(
    container.querySelector('[data-sidebar="group-label"]'),
    "the Bots label",
  );

  expect(pins.textContent).toBe("JuniperMoss");
  expect(follows(pins, automations)).toBe(true);
  expect(follows(automations, bots)).toBe(true);
  expect(bots.textContent).toBe("Bots");
  expect(follows(bots, row("Fern"))).toBe(true);
  expect(pins.contains(row("Juniper"))).toBe(true);
  expect(pins.contains(row("Fern"))).toBe(false);
});

test("shows each bot's status in its avatar and accessible name", () => {
  expect(
    labels().filter((label) => label?.match(/^(Juniper|Moss|Fern|Ash|Birch)/)),
  ).toEqual([
    "Juniper, pinned, has a question",
    "Moss, pinned",
    "Fern, working",
    "Ash",
    "Birch, thinking",
  ]);
  expect(avatarOf("Juniper")).toBe("question");
  expect(avatarOf("Moss")).toBe("idle");
  expect(avatarOf("Fern")).toBe("working");
  expect(avatarOf("Birch")).toBe("thinking");
});

test("follows bot-status events without any chat open", async () => {
  await send("bot-status", { agentId: "ash", status: "failed" });
  await waitFor(() => avatarOf("Ash") === "blocked", "Ash to show blocked");
  expect(row("Ash").getAttribute("aria-label")).toBe("Ash, last reply failed");

  await send("bot-status", { agentId: "juniper", status: "blocked" });
  await waitFor(
    () =>
      row("Juniper").getAttribute("aria-label") ===
      "Juniper, pinned, needs your decision",
    "Juniper to need a decision",
  );
  expect(avatarOf("Juniper")).toBe("blocked");
});

test("marks bots with unread replies", async () => {
  const { notifyReply } = await import("@/lib/notifications");

  const reply = (agentId: string, eventId: string) =>
    act(async () =>
      notifyReply(
        {
          type: "reply",
          eventId,
          serverId: "server",
          agentId,
          agentName: agentId,
          entryId: null,
          origin: "owner",
          preview: "Hello",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        { open: () => {}, pathOf: ({ id }) => `/bots/${id}` },
      ),
    );

  await reply("juniper", "1");
  await reply("juniper", "2");
  await reply("fern", "3");

  expect(row("Juniper").getAttribute("aria-label")).toBe(
    "Juniper, pinned, 2 unread, has a question",
  );
  expect(row("Fern").getAttribute("aria-label")).toBe(
    "Fern, 1 unread, working",
  );
  expect(row("Juniper").querySelector(".bg-bot-strong")).not.toBeNull();
  expect(row("Fern").querySelector(".bg-bot-strong")).not.toBeNull();
  expect(row("Moss").querySelector(".bg-bot-strong")).toBeNull();
});

test("pins a bot from its More menu", async () => {
  const more = defined(
    row("Fern").parentElement?.querySelector('[title="More"]'),
    "Fern's More button",
  );

  await press(
    more,
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  );
  await waitFor(() => menuItem("Pin") !== undefined, "the menu");
  await press(defined(menuItem("Pin"), "Pin"), "click");
  await waitFor(() => written.length === 1, "the write");
  expect(written).toEqual([["agent:juniper", "agent:moss", "agent:fern"]]);
  await waitFor(
    () =>
      defined(
        container.querySelector('[aria-label="Pinned bots"]'),
        "pins",
      ).contains(row("Fern")),
    "Fern among the pins",
  );
});

test("unpins a bot from its context menu", async () => {
  const tile = defined(row("Moss").closest("li"), "Moss's tile");

  await press(tile, "contextmenu");
  await waitFor(() => menuItem("Unpin") !== undefined, "the menu");
  await press(defined(menuItem("Unpin"), "Unpin"), "click");
  await waitFor(() => written.length === 1, "the write");
  expect(written).toEqual([["agent:juniper"]]);
  await settle();
  expect(
    container
      .querySelector('[aria-label="Pinned bots"]')
      ?.contains(row("Moss")),
  ).toBe(false);
});
