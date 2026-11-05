import { expect, spyOn, test } from "bun:test";
import { apiBlob, follow } from "./api";

test("attachment fetch returns a blob without creating a cached object URL", async () => {
  const originalFetch = globalThis.fetch;

  const createObjectURL = spyOn(URL, "createObjectURL").mockReturnValue(
    "blob:test",
  );

  globalThis.fetch = Object.assign(
    async () => new Response("image"),
    originalFetch,
  );

  try {
    const result = await apiBlob("/attachment");
    expect(await result.text()).toBe("image");
    expect(createObjectURL).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
    createObjectURL.mockRestore();
  }
});

function stream(path: string, respond: () => Response) {
  let requests = 0;

  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        requests++;

        return respond();
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  );

  return { path, fetch, requests: () => requests };
}

test("a handler's exception rejects instead of reading as a dropped connection", async () => {
  const events = stream(
    "/events",
    () => new Response("event: snapshot\ndata: {}\n\n"),
  );

  const controller = new AbortController();
  const statuses: string[] = [];

  try {
    await expect(
      follow(
        events.path,
        {
          onStatus: (status) => {
            statuses.push(status);

            if (status === "reconnecting") controller.abort();
          },
          onEvent: () => {
            throw new Error("handler failed");
          },
        },
        controller.signal,
      ),
    ).rejects.toThrow("handler failed");
    expect(statuses).toEqual(["connected"]);
    expect(events.requests()).toBe(1);
  } finally {
    events.fetch.mockRestore();
  }
});

test("a dropped connection reconnects", async () => {
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => controller.error(new Error("connection lost")),
  });

  const controller = new AbortController();
  const statuses: string[] = [];
  const events = stream("/events", () => new Response(body));

  try {
    await follow(
      events.path,
      {
        onStatus: (status) => {
          statuses.push(status);

          if (status === "reconnecting") controller.abort();
        },
        onEvent: () => undefined,
      },
      controller.signal,
    );

    expect(statuses).toEqual(["connected", "reconnecting"]);
  } finally {
    events.fetch.mockRestore();
  }
});
