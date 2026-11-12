import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ok } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect } from "effect";
import { z } from "zod";
import { Store } from "../../test/support/store";
import { Library } from "./library";
import type { LibraryRef } from "./library-repository";
import {
  libraryAction,
  libraryExtension,
  MAX_LIBRARY_OUTPUT_BYTES,
  MAX_LIBRARY_OUTPUT_LINES,
} from "./library-tool";

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "library-tool-"));
  const store = new Store(dir);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  const make = (name: string) =>
    store.createAgent({
      name,
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
  const agent = make("Ada");
  const other = make("Grace");
  const group = store.createGroupChat({
    name: "Group",
    memberIds: [agent.id, other.id],
  });
  const library = store.run(Library.use(Effect.succeed));
  const bot: LibraryRef = { kind: "bot", agentId: agent.id };
  const ownOther: LibraryRef = { kind: "bot", agentId: other.id };
  const shared: LibraryRef = { kind: "group", groupId: group.id };
  const scope = (libraries: LibraryRef[] = [bot], workspace = false) => ({
    library,
    libraries,
    workspace,
  });
  const upload = (ref: LibraryRef, name: string, text: string) =>
    Effect.runPromise(
      library.upload(ref, {
        name,
        mimeType: "text/plain",
        body: new Blob([text]).stream(),
      }),
    );
  return { dir, agent, library, bot, ownOther, shared, scope, upload };
}

const readSchema = z.object({
  text: z.string(),
  nextOffset: z.number().nullable(),
  offset: z.number(),
});
const listSchema = z.object({
  files: z.array(
    z.object({ id: z.string(), library: z.object({ kind: z.string() }) }),
  ),
  before: z.string().nullable(),
});

test("read bounds bytes and lines with a usable byte continuation", async () => {
  const { bot, scope, upload } = setup();
  const large = await upload(bot, "large.txt", "α".repeat(50_000));
  const result = await libraryAction(scope(), {
    action: "read",
    id: large.file.id,
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    MAX_LIBRARY_OUTPUT_BYTES,
  );
  const first = readSchema.parse(result);
  expect(first.nextOffset).toBeGreaterThan(0);
  expect(first.text).not.toContain("�");
  const next = readSchema.parse(
    await libraryAction(scope(), {
      action: "read",
      id: large.file.id,
      offset: first.nextOffset!,
    }),
  );
  expect(first.text + next.text).toBe("α".repeat(50_000));
  const lines = await upload(bot, "lines.txt", "line\n".repeat(3000));
  const page = readSchema.parse(
    await libraryAction(scope(), { action: "read", id: lines.file.id }),
  );
  expect(page.text.split("\n").length - 1).toBe(MAX_LIBRARY_OUTPUT_LINES);
  expect(page.nextOffset).toBe(10_000);
});

test("list bounds output and continues newest first", async () => {
  const { bot, scope, upload } = setup();
  for (let i = 0; i < 100; i++)
    await upload(bot, `${"文".repeat(190)}${i}`, String(i));
  const result = await libraryAction(scope(), { action: "list" });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    MAX_LIBRARY_OUTPUT_BYTES,
  );
  const first = listSchema.parse(result);
  expect(first.before).not.toBeNull();
  const next = listSchema.parse(
    await libraryAction(scope(), { action: "list", before: first.before! }),
  );
  expect(next.files.length).toBeGreaterThan(0);
  expect(first.files.at(-1)!.id > next.files[0]!.id).toBe(true);
});

test("search bounds matches and returns continuation offsets", async () => {
  const { bot, scope, upload } = setup();
  const file = await upload(
    bot,
    "matches.txt",
    "needle and context\n".repeat(4000),
  );
  const result = await libraryAction(scope(), {
    action: "search",
    id: file.file.id,
    query: "needle",
  });
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
    MAX_LIBRARY_OUTPUT_BYTES,
  );
  const parsed = z
    .object({
      matches: z.array(z.object({ offset: z.number() })),
      nextOffset: z.number(),
    })
    .parse(result);
  expect(parsed.matches.length).toBeGreaterThan(0);
  expect(parsed.matches.length).toBeLessThanOrEqual(MAX_LIBRARY_OUTPUT_LINES);
  const next = z
    .object({ matches: z.array(z.object({ offset: z.number() })) })
    .parse(
      await libraryAction(scope(), {
        action: "search",
        id: file.file.id,
        query: "needle",
        offset: parsed.nextOffset,
      }),
    );
  expect(next.matches[0]?.offset).toBe(parsed.nextOffset);
});

test("bot and group scopes expose only the allowed libraries with labels", async () => {
  const { bot, ownOther, shared, scope, upload } = setup();
  const own = await upload(bot, "own.txt", "own");
  const group = await upload(shared, "group.txt", "group");
  const foreign = await upload(ownOther, "foreign.txt", "foreign");
  expect(
    listSchema
      .parse(await libraryAction(scope(), { action: "list" }))
      .files.map((file) => file.id),
  ).toEqual([own.file.id]);
  const combined = listSchema.parse(
    await libraryAction(scope([bot, shared]), { action: "list" }),
  );
  expect(combined.files.map((file) => file.id)).toEqual([
    group.file.id,
    own.file.id,
  ]);
  expect(combined.files.map((file) => file.library.kind)).toEqual([
    "group",
    "bot",
  ]);
  await expect(
    libraryAction(scope([bot, shared]), {
      action: "read",
      id: foreign.file.id,
    }),
  ).rejects.toThrow("File not found");
});

function environment(dir: string) {
  const workspace = join(dir, "workspace");
  mkdirSync(workspace);
  const env = new NodeExecutionEnv({ cwd: workspace });
  const mapped = (path: string) => {
    if (path !== "/workspace" && !path.startsWith("/workspace/"))
      throw new Error("Unexpected path outside test workspace");
    return join(workspace, path.slice("/workspace".length));
  };
  const canonical = env.canonicalPath.bind(env);
  env.canonicalPath = async (path, context) => {
    const result = await canonical(mapped(path), context);
    if (!result.ok) return result;
    return ok(
      result.value === workspace
        ? "/workspace"
        : result.value.startsWith(`${workspace}/`)
          ? `/workspace/${result.value.slice(workspace.length + 1)}`
          : result.value,
    );
  };
  const write = env.writeFile.bind(env);
  env.writeFile = (path, content, context) =>
    write(mapped(path), content, context);
  const append = env.appendFile.bind(env);
  env.appendFile = (path, content, context) =>
    append(mapped(path), content, context);
  const info = env.fileInfo.bind(env);
  env.fileInfo = (path, context) => info(mapped(path), context);
  const create = env.createDir.bind(env);
  env.createDir = (path, options, context) =>
    create(mapped(path), options, context);
  return { env, context: BACKGROUND_CONTEXT, workspace };
}

test("copy sanitizes upload names and writes bytes only inside the workspace", async () => {
  const { dir, bot, scope, upload } = setup();
  const file = await upload(bot, "../../notes.txt", "copied bytes");
  const target = environment(dir);
  const copied = await libraryAction(
    scope([bot], true),
    { action: "copy", id: file.file.id },
    target,
  );
  expect(copied).toMatchObject({ path: "/workspace/library/notes.txt" });
  expect(
    await Bun.file(join(target.workspace, "library/notes.txt")).text(),
  ).toBe("copied bytes");
  for (const path of ["../../etc/x", "/etc/x", "/workspace-other/x"])
    await expect(
      libraryAction(
        scope([bot], true),
        { action: "copy", id: file.file.id, path },
        target,
      ),
    ).rejects.toThrow("inside /workspace");
  const outside = join(dir, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(target.workspace, "link"));
  await expect(
    libraryAction(
      scope([bot], true),
      { action: "copy", id: file.file.id, path: "link/x" },
      target,
    ),
  ).rejects.toThrow("inside /workspace");
  const missing = join(outside, "missing");
  symlinkSync(missing, join(target.workspace, "dangling"));
  await expect(
    libraryAction(
      scope([bot], true),
      { action: "copy", id: file.file.id, path: "dangling" },
      target,
    ),
  ).rejects.toThrow("inside /workspace");
  expect(await Bun.file(missing).exists()).toBe(false);
  await expect(
    libraryAction(scope(), { action: "copy", id: file.file.id }, target),
  ).rejects.toThrow("requires a workspace");
});

test("a bot without a workspace has no copy action", () => {
  const { agent, library, bot } = setup();
  const extension = libraryExtension({
    agent,
    library,
    libraries: () => [bot],
    workspace: false,
  });
  expect(JSON.stringify(extension.tools)).not.toContain('"copy"');
});
