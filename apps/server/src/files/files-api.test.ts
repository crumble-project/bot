import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer, Scope } from "effect";
import { Store } from "../../test/support/store";
import { contractApp } from "../contract/api-contract";
import { handleApiError } from "../app/api-errors";
import { limitBodies, pathRegister } from "../app/api-requests";
import { runnerOf } from "../shared/runner";
import { Library } from "./library";
import { registerFileRoutes } from "./files-api";

const cleanup: (() => void)[] = [];

afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "files-api-"));
  const store = new Store(dir);

  const agent = store.createAgent({
    name: "A",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  const other = store.createAgent({
    name: "B",
    description: "",
    instructions: "",
    provider: "faux",
    model: "chat",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  const group = store.createGroupChat({ name: "G", memberIds: [agent.id] });
  const scope = Scope.makeUnsafe();
  const core = store.runtime.runSync(Effect.context());

  const context = Effect.runSync(
    Layer.buildWithScope(Library.layer({ maxFileBytes: 1024 }), scope).pipe(
      Effect.provideContext(core),
    ),
  );

  const app = contractApp();
  limitBodies(app);
  app.onError(handleApiError);
  registerFileRoutes({ register: pathRegister(app), run: runnerOf(context) });
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => store.close(),
    () => Effect.runSync(Scope.close(scope, Exit.void)),
  );

  return {
    app,
    bot: `/v1/agents/${agent.id}/files`,
    other: `/v1/agents/${other.id}/files`,
    group: `/v1/group-chats/${group.id}/files`,
  };
}

for (const kind of ["bot", "group"] as const) {
  test(`${kind} file routes stream, deduplicate, isolate and delete`, async () => {
    const env = setup();
    const path = env[kind];

    const upload = (name: string, type: string, body: string) =>
      env.app.request(path, {
        method: "POST",
        headers: {
          "X-File-Name": encodeURIComponent(name),
          "Content-Type": type,
        },
        body,
      });

    const firstResponse = await upload(
      "über.zip",
      "application/zip",
      "zip bytes",
    );

    expect(firstResponse.status).toBe(201);
    const first = await firstResponse.json();
    expect(first.file.name).toBe("über.zip");

    const duplicate = await (
      await upload("other.zip", "application/zip", "zip bytes")
    ).json();

    expect(duplicate.existed).toBe(true);
    expect(duplicate.file.id).toBe(first.file.id);

    const html = await (
      await upload("a.png", "text/html", "<script>x</script>")
    ).json();

    const listed = await (await env.app.request(path)).json();
    expect(listed.map((file: { id: string }) => file.id)).toEqual([
      html.file.id,
      first.file.id,
    ]);

    const page = await (
      await env.app.request(`${path}?limit=1&before=${html.file.id}`)
    ).json();

    expect(page.map((file: { id: string }) => file.id)).toEqual([
      first.file.id,
    ]);
    const downloaded = await env.app.request(`${path}/${html.file.id}`);
    expect(downloaded.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(downloaded.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    expect(downloaded.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(downloaded.headers.get("cache-control")).toBe("private, no-cache");
    const etag = downloaded.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect((await env.app.request(`${env.other}/${html.file.id}`)).status).toBe(
      404,
    );
    expect(
      (
        await env.app.request(`${env.other}/${html.file.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);
    expect(
      (await env.app.request(`${path}/${html.file.id}`, { method: "DELETE" }))
        .status,
    ).toBe(204);
    expect(
      (
        await env.app.request(`${path}/${html.file.id}`, {
          headers: { "If-None-Match": etag },
        })
      ).status,
    ).toBe(404);

    const pdf = await env.app.request(path, {
      method: "POST",
      headers: {
        "X-File-Name": "document.pdf",
        "Content-Type": "application/pdf",
      },
      body: await Bun.file(
        new URL("../../test/fixtures/text.pdf", import.meta.url),
      ).arrayBuffer(),
    });

    expect(pdf.status).toBe(201);
    expect((await pdf.json()).file.mimeType).toBe("application/pdf");

    const empty = await upload("empty.bin", "application/octet-stream", "");
    expect(empty.status).toBe(201);
    expect((await empty.json()).file.size).toBe(0);

    const early = await env.app.request(path, {
      method: "POST",
      headers: {
        "X-File-Name": "%C3%BCber.bin",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(100 * 1024 * 1024 + 1),
      },
      body: "x",
    });

    expect(early.status).toBe(413);
    expect(await early.text()).toBe("über.bin is larger than 100 MB");

    const image = await (
      await upload("image.png", "image/png", "png bytes")
    ).json();

    expect(
      (await env.app.request(`${path}/${image.file.id}`)).headers.get(
        "content-type",
      ),
    ).toBe("image/png");
    const anotherAccount = setup();
    expect((await anotherAccount.app.request(path)).status).toBe(404);
    expect(
      (await anotherAccount.app.request(`${path}/${first.file.id}`)).status,
    ).toBe(404);
    expect(
      (
        await anotherAccount.app.request(`${path}/${first.file.id}`, {
          method: "DELETE",
        })
      ).status,
    ).toBe(404);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1025));
      },
    });

    const streamed = await env.app.request(path, {
      method: "POST",
      headers: {
        "X-File-Name": "big.bin",
        "Content-Type": "application/octet-stream",
      },
      body: stream,
    });

    expect(streamed.status).toBe(413);
    expect(await streamed.text()).toContain("big.bin is larger than 1 KB");

    const tooLarge = await upload(
      "big.bin",
      "application/octet-stream",
      "x".repeat(1025),
    );

    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.text()).toContain("big.bin is larger than 1 KB");
    expect(
      (
        await env.app.request(path, {
          method: "POST",
          headers: { "X-File-Name": "%zz", "Content-Type": "text/plain" },
          body: "x",
        })
      ).status,
    ).toBe(400);
  });
}
