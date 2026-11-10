import { expect, spyOn, test } from "bun:test";
import { QueryClientProvider } from "@tanstack/react-query";
import { Window } from "happy-dom";
import { type ReactNode, act } from "react";
import type { Message } from "@/features/chat/api";
import type { CardChat } from "@/features/chat/message-card";
import { queryClient } from "@/lib/api";
import { waitFor, waitForIdle } from "@/test/wait-for";
import type { CallRequest } from "./api";

const LIST = "/v1/agents/bot/call-requests";

const REQUEST = `${LIST}/r1`;

const opened: string[] = [];

const chat: CardChat = {
  botId: "bot",
  botName: "Ada",
  attachmentPath: () => "",
  jobStatus: () => undefined,
  onOpenJob: () => {},
  onOpenCall: (requestId) => opened.push(requestId),
};

const pending: CallRequest = {
  id: "r1",
  agentId: "bot",
  number: "+49301234567",
  callee: "Trattoria Roma",
  goal: "Book a table for 2 on Friday at 19:00.",
  opening:
    "Hi, this is Ada, Leonhard's AI assistant. I transcribe this call. I'm calling about dinner on Friday.",
  status: "pending",
  callId: null,
  conversationId: null,
  outcome: null,
  error: null,
  requestedAt: "2026-11-10T10:00:00.000Z",
  decidedAt: null,
  endedAt: null,
};

const calling: CallRequest = {
  ...pending,
  status: "calling",
  callId: "c1",
  conversationId: "conv",
  decidedAt: "2026-11-10T10:01:00.000Z",
};

const ended = (
  outcome: NonNullable<CallRequest["outcome"]>,
  error: string | null = null,
): CallRequest => ({
  ...calling,
  status: "ended",
  outcome,
  error,
  endedAt: "2026-11-10T10:03:00.000Z",
});

const toolResult: Message = {
  id: "t:1:0",
  entryId: "t:1",
  role: "toolResult",
  content: "",
  toolName: "request_call",
  toolDetails: pending,
};

type Page = {
  container: HTMLElement;
  sent: string[];
  button: (label: string) => HTMLButtonElement | undefined;
  shows: (text: string) => Promise<void>;
};

async function renderCard(
  respond: (method: string, path: string) => Response | null,
  run: (page: Page) => Promise<void>,
  element?: ReactNode,
) {
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

  const sent: string[] = [];

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();
        const method = init?.method ?? "GET";

        if (method !== "GET") sent.push(`${method} ${path}`);

        const response = respond(method, path);

        if (response) return response;

        throw new Error(`Unexpected request: ${method} ${path}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  const { createRoot } = await import("react-dom/client");
  const { ToolResultRow } = await import("@/features/bot-chat/chat-cards");
  const container = document.createElement("div");

  document.body.append(container);

  const root = createRoot(container);

  const button = (label: string) =>
    [...container.querySelectorAll("button")].find(
      (each) => each.textContent?.trim() === label,
    );

  const shows = (text: string) =>
    waitFor(() => container.textContent?.includes(text) === true, text);

  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          {element ?? <ToolResultRow message={toolResult} chat={chat} />}
        </QueryClientProvider>,
      ),
    );
    await run({ container, sent, button, shows });
    await waitForIdle(queryClient);
  } finally {
    await act(async () => root.unmount());
    queryClient.clear();
    fetch.mockRestore();

    for (const key of Object.keys(values)) {
      if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
      else Reflect.deleteProperty(globalThis, key);
    }

    window.close();
  }
}

test("a pending call request shows the call and the opening's checklist, and a refused approval keeps the buttons", async () => {
  await renderCard(
    (method, path) => {
      if (method === "GET" && path === LIST) return Response.json([pending]);

      if (method === "POST" && path === `${REQUEST}/approve`)
        return Response.json(
          { error: "The voice gateway isn't connected." },
          { status: 409 },
        );

      return null;
    },
    async ({ container, sent, button, shows }) => {
      await waitFor(() => button("Approve") !== undefined, "the buttons");

      const text = container.textContent ?? "";

      expect(text).toContain("Trattoria Roma");
      expect(text).toContain("+49301234567");
      expect(text).toContain(pending.goal);
      expect(text).toContain(
        "Check that the opening says it's an AI assistant, whom it calls for, that the call is transcribed, and why it calls.",
      );
      expect(container.querySelector("blockquote")?.textContent).toBe(
        pending.opening,
      );
      expect(button("Decline")).toBeDefined();

      await act(async () => button("Approve")!.click());
      await shows("The voice gateway isn't connected.");
      await waitFor(() => !button("Approve")!.disabled, "the buttons again");

      expect(sent).toStrictEqual([`POST ${REQUEST}/approve`]);
      expect(button("Decline")).toBeDefined();
    },
  );
});

test("approving shows the call as calling, and declining settles the card", async () => {
  let state = pending;

  await renderCard(
    (method, path) => {
      if (method === "GET" && path === LIST) return Response.json([state]);

      if (method === "POST" && path === `${REQUEST}/approve`) {
        state = calling;

        return Response.json(state);
      }

      return null;
    },
    async ({ container, sent, button, shows }) => {
      await waitFor(() => button("Approve") !== undefined, "the buttons");
      await act(async () => button("Approve")!.click());
      await shows("Calling");

      expect(sent).toStrictEqual([`POST ${REQUEST}/approve`]);
      expect(button("Approve")).toBeUndefined();
      expect(container.querySelector('[aria-label="Calling"]')).not.toBeNull();
    },
  );

  state = pending;

  await renderCard(
    (method, path) => {
      if (method === "GET" && path === LIST) return Response.json([state]);

      if (method === "POST" && path === `${REQUEST}/decline`) {
        state = { ...pending, status: "declined" };

        return Response.json(state);
      }

      return null;
    },
    async ({ sent, button, shows }) => {
      await waitFor(() => button("Decline") !== undefined, "the buttons");
      await act(async () => button("Decline")!.click());
      await shows("Declined");

      expect(sent).toStrictEqual([`POST ${REQUEST}/decline`]);
      expect(button("Approve")).toBeUndefined();
    },
  );
});

test("an ended call shows its outcome from the list, and a failed one its error", async () => {
  const cases: [CallRequest, string][] = [
    [ended("unanswered"), "Not answered"],
    [ended("busy"), "Busy"],
    [
      ended("failed", "outside calls are switched off on this voice gateway"),
      "Failed",
    ],
  ];

  for (const [request, outcome] of cases)
    await renderCard(
      (method, path) =>
        method === "GET" && path === LIST ? Response.json([request]) : null,
      async ({ container, button, shows }) => {
        await shows(outcome);

        if (request.error)
          expect(container.textContent).toContain(request.error);
        expect(button("Approve")).toBeUndefined();
      },
    );
});

test("a placed call's card opens the call beside the chat", async () => {
  await renderCard(
    (method, path) =>
      method === "GET" && path === LIST
        ? Response.json([ended("answered")])
        : null,
    async ({ container, shows }) => {
      await shows("Answered");
      opened.length = 0;
      await act(async () => container.querySelector("button")!.click());
      expect(opened).toStrictEqual(["r1"]);
    },
  );
});

test("an outside call's end notice is one card with how the call went, and an owner call's notice keeps its marker", async () => {
  const notice = (requestId: string, content: string): Message => ({
    id: "n:1:0",
    entryId: "n:1",
    role: "user",
    kind: "crumble.message",
    content,
    requestId,
    origin: { kind: "call" },
  });

  const { CallNotice } = await import("./call-request-card");

  for (const [message, expected] of [
    [
      notice(
        "voice-call:c1:ended",
        "Call to Trattoria Roma ended after 2 minutes: the bot hung up.",
      ),
      "Trattoria RomaAnsweredended after 2 minutes: the bot hung up.",
    ],
    [
      notice("voice-call:other:ended", "Call ended after 4 minutes."),
      "the marker",
    ],
  ] as const)
    await renderCard(
      (method, path) =>
        method === "GET" && path === LIST
          ? Response.json([ended("answered")])
          : null,
      async ({ container, shows }) => {
        await shows(expected === "the marker" ? "the marker" : "Answered");
        expect(container.textContent).toBe(expected);

        if (expected === "the marker") return;
        opened.length = 0;
        await act(async () => container.querySelector("button")!.click());
        expect(opened).toStrictEqual(["r1"]);
      },
      <CallNotice message={message} chat={chat} fallback="the marker" />,
    );
});

test("the call panel shows the goal, the opening, and what was said in order, labeled with the bot and the callee", async () => {
  const { CallPanel } = await import("./call-panel");

  const transcript = {
    messages: [
      { id: "c:1:0", entryId: "c:1", role: "user", content: "Trattoria Roma." },
      {
        id: "c:2:0",
        entryId: "c:2",
        role: "assistant",
        content: "A table for two on Friday at seven, please.",
      },
      { id: "c:3:0", entryId: "c:3", role: "user", content: "That works." },
    ],
    hasMore: false,
    oldestEntryId: "c:1",
  };

  for (const [page, expected] of [
    [
      transcript,
      [
        `Ada${pending.opening}`,
        "Trattoria RomaTrattoria Roma.",
        "AdaA table for two on Friday at seven, please.",
        "Trattoria RomaThat works.",
      ],
    ],
    [
      { messages: [], hasMore: false, oldestEntryId: null },
      [`Ada${pending.opening}`, "No transcript."],
    ],
  ] as const)
    await renderCard(
      (method, path) => {
        if (method !== "GET") return null;

        if (path === LIST) return Response.json([ended("answered")]);

        if (path === `${REQUEST}/transcript?limit=200`)
          return Response.json(page);

        return null;
      },
      async ({ container, shows }) => {
        await shows("Answered");
        await shows(pending.goal);
        await waitFor(
          () => container.querySelectorAll("li").length === expected.length,
          "the transcript",
        );
        expect(
          [...container.querySelectorAll("li")].map((item) => item.textContent),
        ).toStrictEqual([...expected]);
      },
      <CallPanel botId="bot" botName="Ada" requestId="r1" onClose={() => {}} />,
    );
});
