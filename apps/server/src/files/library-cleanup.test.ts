import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { Store } from "../../test/support/store";
import { runtimeCallbacks } from "../../test/support/runtime-callbacks";
import { AgentRuntime } from "../bots/runtime";
import { standaloneBots } from "../bots/bots-test-support";
import { standaloneGroupChats } from "../group-chats/group-chats-test-support";
import { GroupTranscripts } from "../group-chats/group-transcripts";
import { Library } from "./library";
import { FileStore } from "./file-store";
import { AgentRepository } from "../bot-store/agent-repository";
import type { LibraryRef } from "./library-repository";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "library-cleanup-"));
  const store = new Store(dir);
  const runtime = new AgentRuntime(join(dir, "agents"), runtimeCallbacks());
  const bots = standaloneBots(store, runtime);
  const transcripts = new GroupTranscripts(join(dir, "groups"));
  const groups = standaloneGroupChats(bots, transcripts);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => bots.close());
  cleanups.push(() => transcripts.close());
  cleanups.push(() => groups.close());
  const agent = store.createAgent({
    name: "Ada",
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
  const group = store.createGroupChat({ name: "Group", memberIds: [agent.id] });
  const library = store.run(Library);
  const files = store.run(FileStore);
  const bot: LibraryRef = { kind: "bot", agentId: agent.id };
  const shared: LibraryRef = { kind: "group", groupId: group.id };
  const upload = (ref: LibraryRef) =>
    Effect.runPromise(
      library.upload(ref, {
        name: "shared.txt",
        mimeType: "text/plain",
        body: new Blob(["shared bytes"]).stream(),
      }),
    );
  return {
    store,
    bots,
    groups,
    library,
    files,
    bot,
    shared,
    upload,
    agent,
    group,
  };
}

test("owner deletion holds the lock until new uploads can no longer create entries", async () => {
  const fixture = setup();
  await fixture.upload(fixture.bot);
  const owners = fixture.store.run(AgentRepository);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const removal = Effect.runPromise(
    fixture.library.removeLibrary(
      fixture.bot,
      Effect.gen(function* () {
        entered.resolve();
        yield* Effect.promise(() => release.promise);
        yield* owners.delete(fixture.agent.id);
      }),
    ),
  );
  await entered.promise;
  let completed = false;
  const next = Effect.runPromise(
    fixture.library
      .upload(fixture.bot, {
        name: "late.txt",
        mimeType: "text/plain",
        body: new Blob(["late"]).stream(),
      })
      .pipe(Effect.flip),
  ).then((error) => {
    completed = true;
    return error;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed).toBe(false);
  } finally {
    release.resolve();
  }
  await removal;
  expect((await next)._tag).toBe("NotFound");
});

for (const kind of ["bot", "group"] as const) {
  test(`deleting a ${kind} removes its library and unshared bytes`, async () => {
    const fixture = setup();
    const ref = kind === "bot" ? fixture.bot : fixture.shared;
    const uploaded = await fixture.upload(ref);
    const entry = (
      await Effect.runPromise(fixture.library.entries(ref, [uploaded.file.id]))
    ).get(uploaded.file.id)!;
    if (kind === "bot") await fixture.bots.deleteAgent(fixture.agent.id);
    else await fixture.groups.delete(fixture.group.id);
    expect(
      (await Effect.runPromise(fixture.library.entries(ref, [entry.id]))).size,
    ).toBe(0);
    expect(
      (
        await Effect.runPromise(
          fixture.files.bytes(entry.hash).pipe(Effect.flip),
        )
      )._tag,
    ).toBe("NotFound");
    expect(await Effect.runPromise(fixture.files.text(entry.hash))).toBeNull();
  });

  test(`deleting a ${kind} preserves bytes referenced by the other library`, async () => {
    const fixture = setup();
    const own = kind === "bot" ? fixture.bot : fixture.shared;
    const other = kind === "bot" ? fixture.shared : fixture.bot;
    await fixture.upload(own);
    const retained = await fixture.upload(other);
    if (kind === "bot") await fixture.bots.deleteAgent(fixture.agent.id);
    else await fixture.groups.delete(fixture.group.id);
    const download = await Effect.runPromise(
      fixture.library.download(other, retained.file.id),
    );
    expect(await new Response(download.body).text()).toBe("shared bytes");
  });
}
