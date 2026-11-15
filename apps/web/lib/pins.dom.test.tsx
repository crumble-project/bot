import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { z } from "zod";
import { settle, waitFor } from "@/test/wait-for";
import type { Pins } from "./pins";

type Conversation = { id: string };

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

/** The account's list on the stub server, and every list written to it. */
let stored: string[] = [];
let written: string[][] = [];
let failWrites = false;

/** Answers sessions without a pins list, as before it loads or from an older server. */
let omitPins = false;

let release = () => {};
let pins: Pins | undefined;
let root: Root;
let notifySession: () => void;

let renderPins: (
  bots?: Conversation[],
  groups?: Conversation[],
) => Promise<void>;

let fetch: ReturnType<typeof stubServer>;

const removedListeners = spyOn(window, "removeEventListener");

const stubServer = () =>
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = input instanceof Request ? input.url : input.toString();

        if (path.endsWith("/update-user")) {
          const body = z
            .object({ pinnedConversations: z.array(z.string()) })
            .parse(JSON.parse(z.string().parse(init?.body)));

          written.push(body.pinnedConversations);

          if (failWrites) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });

            return new Response("Unavailable", { status: 503 });
          }

          stored = body.pinnedConversations;

          return Response.json({ status: true });
        }

        if (path.endsWith("/get-session"))
          return Response.json({
            session: { id: "s", userId: "u" },
            user: omitPins
              ? { id: "u" }
              : { id: "u", pinnedConversations: stored },
          });

        return Response.json(null);
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

const bots = [{ id: "a" }, { id: "b" }];
const groups = [{ id: "g" }];

const current = () => {
  if (!pins) throw new Error("usePins has not rendered");

  return pins;
};

const shows = (keys: string[]) => () =>
  JSON.stringify(current().pinned) === JSON.stringify(keys);

/** Loads `keys` as the session's list and waits for the hook to show `expected`. */
async function load(keys: string[], expected = keys) {
  stored = keys;
  await act(async () => notifySession());
  await waitFor(shows(expected), `pins ${expected.join(",")}`);
  written = [];
}

beforeAll(async () => {
  fetch = stubServer();

  for (const [key, value] of Object.entries(values))
    Object.defineProperty(globalThis, key, { configurable: true, value });

  const { createRoot } = await import("react-dom/client");
  const { usePins } = await import("./pins");
  const { authClient } = await import("./auth-client");
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  notifySession = () => authClient.$store.notify("$sessionSignal");

  function Harness(props: {
    bots: Conversation[] | undefined;
    groups: Conversation[] | undefined;
  }) {
    pins = usePins(props.bots, props.groups);

    return null;
  }

  renderPins = async (nextBots, nextGroups) => {
    await act(async () =>
      root.render(<Harness bots={nextBots} groups={nextGroups} />),
    );
  };
});

beforeEach(async () => {
  failWrites = false;
  omitPins = false;
  await renderPins(bots, groups);
});

afterAll(async () => {
  await act(async () => root.unmount());
  // The auth client stops a second after its last consumer, and needs the window to.
  await waitFor(
    () => removedListeners.mock.calls.some(([type]) => type === "storage"),
    "the session store to stop",
  );
  fetch.mockRestore();

  for (const key of Object.keys(values)) {
    if (globals[key]) Object.defineProperty(globalThis, key, globals[key]);
    else Reflect.deleteProperty(globalThis, key);
  }

  window.close();
});

test("pin adds the conversation at the end", async () => {
  await load(["group:g"]);
  await act(async () => current().pin("agent:a"));
  expect(current().pinned).toEqual(["group:g", "agent:a"]);
  await waitFor(() => stored.length === 2, "the write");
  expect(written).toEqual([["group:g", "agent:a"]]);
  await settle();
  expect(current().pinned).toEqual(["group:g", "agent:a"]);
});

test("unpin removes the conversation", async () => {
  await load(["agent:a", "group:g"]);
  await act(async () => current().unpin("agent:a"));
  expect(current().pinned).toEqual(["group:g"]);
  await waitFor(() => written.length === 1, "the write");
  expect(written).toEqual([["group:g"]]);
});

test("move puts the conversation at the target's place", async () => {
  await load(["agent:a", "agent:b", "group:g"]);
  await act(async () => current().move("agent:a", "group:g"));
  expect(current().pinned).toEqual(["agent:b", "group:g", "agent:a"]);
  await act(async () => current().move("agent:a", "agent:b"));
  expect(current().pinned).toEqual(["agent:a", "agent:b", "group:g"]);
  await waitFor(shows(["agent:a", "agent:b", "group:g"]), "the saved order");
  await waitFor(() => stored[0] === "agent:a", "the last write");
  expect(written.at(-1)).toEqual(["agent:a", "agent:b", "group:g"]);
});

test("a write drops pins for conversations that are gone", async () => {
  await load(["agent:gone", "agent:a"], ["agent:a"]);
  await act(async () => current().pin("group:g"));
  await waitFor(() => written.length === 1, "the write");
  expect(written).toEqual([["agent:a", "group:g"]]);
});

test("a tenth pin is refused", async () => {
  const many = Array.from({ length: 10 }, (_, index) => ({ id: `${index}` }));
  await renderPins(many, groups);

  const nine = many.slice(0, 9).map(({ id }) => `agent:${id}`);
  await load(nine);
  expect(current().canPin("agent:9")).toBe(false);
  await act(async () => current().pin("agent:9"));
  await settle();
  expect(written).toEqual([]);
  expect(current().pinned).toEqual(nine);
});

test("changes wait until bots and groups have loaded", async () => {
  await load(["agent:a"]);
  await renderPins(bots, undefined);
  expect(current().ready).toBe(false);
  expect(current().canPin("agent:b")).toBe(false);
  await act(async () => {
    current().pin("agent:b");
    current().unpin("agent:a");
  });
  await settle();
  expect(written).toEqual([]);
  expect(stored).toEqual(["agent:a"]);
});

test("a failed write rolls back to the session's list", async () => {
  await load(["agent:a"]);
  failWrites = true;
  await act(async () => current().pin("agent:b"));
  await waitFor(() => written.length === 1, "the write");
  expect(current().pinned).toEqual(["agent:a", "agent:b"]);
  await act(async () => release());
  await waitFor(shows(["agent:a"]), "the rollback");
  expect(written).toEqual([["agent:a", "agent:b"]]);
});

test("changes wait until the session's list has loaded", async () => {
  await load(["agent:a"]);
  omitPins = true;
  await act(async () => notifySession());
  await waitFor(() => !current().ready, "the list to go");
  await act(async () => current().pin("agent:b"));
  await settle();
  expect(written).toEqual([]);
  expect(stored).toEqual(["agent:a"]);
});
