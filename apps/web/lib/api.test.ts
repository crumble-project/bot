import { expect, spyOn, test } from "bun:test";
import { apiBlob, bodyOf, follow } from "./api";

test("JSON responses are validated against their route's success schema", async () => {
  await expect(
    bodyOf("health", Response.json({ status: "ok", apiVersion: 1 })),
  ).resolves.toEqual({ status: "ok", apiVersion: 1 });
  await expect(
    bodyOf("health", Response.json({ status: "ok", apiVersion: "1" })),
  ).rejects.toThrow();
  await expect(bodyOf("health", Response.json({}))).rejects.toThrow();
});

test("JSON response validation uses the actual success status", async () => {
  const file = {
    id: "00000000-0000-4000-8000-000000000001",
    name: "note.txt",
    mimeType: "text/plain",
    size: 1,
    createdAt: "2026-01-01",
  };
  await expect(
    bodyOf(
      "uploadFile",
      Response.json({ file, existed: false }, { status: 201 }),
    ),
  ).resolves.toEqual({ file, existed: false });
  await expect(
    bodyOf("uploadFile", Response.json({ file, existed: false })),
  ).rejects.toThrow("No JSON response schema for uploadFile (200)");
});

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
