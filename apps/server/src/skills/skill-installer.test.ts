import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { GitHubUnavailable } from "../github-apps/github-api";
import { ChangeReverter } from "./change-reverter";
import { GitHubSkillReader, parseSkillLocation } from "./github-skills";
import { SkillInstaller } from "./skill-installer";
import { standaloneSkills } from "./skills";
import { Store } from "../../test/support/store";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

type Files = Record<string, string>;

/** A public repository on a fake GitHub: `push` makes a new commit on `main`. */
function fakeGitHub(files: Files) {
  const commits = new Map<string, Files>();
  let head = "";
  const calls: string[] = [];

  const push = (next: Files) => {
    head = createHash("sha1").update(JSON.stringify(next)).digest("hex");
    commits.set(head, next);
  };

  push(files);

  const filesAt = (commit: string): Files => commits.get(commit) ?? {};

  const reader = GitHubSkillReader.of({
    head: (repository, branch) => {
      calls.push(`head ${repository}`);

      return repository === "acme/skills"
        ? Effect.succeed({ branch: branch ?? "main", commit: head })
        : Effect.fail(new GitHubUnavailable({ message: "no", status: 404 }));
    },
    tree: (_repository, commit) => {
      calls.push("tree");

      return Effect.succeed(
        Object.entries(filesAt(commit)).map(([path, content]) => ({
          path,
          type: "blob",
          sha: createHash("sha1").update(content).digest("hex"),
          size: Buffer.byteLength(content),
        })),
      );
    },
    file: (_repository, commit, path) => {
      calls.push(`file ${path}`);

      return Effect.succeed(filesAt(commit)[path] ?? "");
    },
  });

  return { reader, push, calls, files: () => commits.get(head)! };
}

const skill = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: >\n  ${description}\n---\n\n${body}\n`;

const REPOSITORY = {
  "README.md": "# Skills",
  "skills/review/SKILL.md": skill("review", "Review a diff", "Read it all."),
  "skills/review/references/checklist.md": "- tests",
  "skills/review/scripts/lint.sh": "echo lint",
  "skills/empty/SKILL.md": "---\nname: empty\n---\n",
  "skills/notes/SKILL.md": skill("notes", "Take notes", "Write it down."),
} satisfies Files;

function setup(files: Files = REPOSITORY) {
  const dir = mkdtempSync(join(tmpdir(), "bot-installer-"));
  dirs.push(dir);
  const store = new Store(dir);
  const github = fakeGitHub(files);

  const installer = store.runtime.runSync(
    SkillInstaller.make.pipe(
      Effect.provideService(GitHubSkillReader, github.reader),
    ),
  );

  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

  return { store, github, installer, run };
}

test("reads owner/repo and github.com links to repositories, folders, and SKILL.md files", () => {
  expect(parseSkillLocation("acme/skills")).toEqual({
    repository: "acme/skills",
    branch: null,
    path: "",
  });
  expect(parseSkillLocation("https://github.com/acme/skills.git")).toEqual({
    repository: "acme/skills",
    branch: null,
    path: "",
  });
  expect(
    parseSkillLocation("github.com/acme/skills/tree/dev/skills/review/"),
  ).toEqual({
    repository: "acme/skills",
    branch: "dev",
    path: "skills/review",
  });
  expect(
    parseSkillLocation(
      "https://github.com/acme/skills/blob/main/skills/review/SKILL.md",
    ),
  ).toEqual({
    repository: "acme/skills",
    branch: "main",
    path: "skills/review",
  });
  expect(parseSkillLocation("https://gitlab.com/acme/skills")).toBeNull();
  expect(parseSkillLocation("not a repository")).toBeNull();
});

test("lists every skill folder with what it imports and why one can't be installed", async () => {
  const { store, installer, run } = setup();

  store.createSkill({
    name: "Notes",
    description: "",
    instructions: "Mine",
    documents: [],
  });

  const listing = await run(installer.browse("acme/skills"));

  expect(listing.branch).toBe("main");
  expect(
    listing.skills.map(({ path, name, status, problem, skipped }) => ({
      path,
      name,
      status,
      problem,
      skipped,
    })),
  ).toEqual([
    {
      path: "skills/empty",
      name: "empty",
      status: "invalid",
      problem: "SKILL.md has no instructions",
      skipped: [],
    },
    {
      path: "skills/notes",
      name: "notes",
      status: "clash",
      problem: "A shared skill named Notes already exists",
      skipped: [],
    },
    {
      path: "skills/review",
      name: "review",
      status: "new",
      problem: null,
      skipped: ["scripts/lint.sh"],
    },
  ]);
  expect(listing.skills[2]?.description).toBe("Review a diff");

  const narrowed = await run(
    installer.browse("https://github.com/acme/skills/tree/main/skills/review"),
  );

  expect(narrowed.skills.map((found) => found.path)).toEqual(["skills/review"]);
  store.close();
});

test("a repository GitHub doesn't have is not found", async () => {
  const { store, installer } = setup();

  const exit = await Effect.runPromiseExit(installer.browse("acme/private"));

  expect(JSON.stringify(exit)).toContain("Only public repositories");
  store.close();
});

test("installs read-only shared skills with their documents, all or none", async () => {
  const { store, installer, run } = setup();
  const listing = await run(installer.browse("acme/skills"));

  const request = {
    repository: listing.repository,
    branch: listing.branch,
    commit: listing.commit,
    paths: ["skills/review"],
  };

  const [review] = await run(installer.install(request));

  expect(review).toMatchObject({
    agentId: null,
    name: "review",
    description: "Review a diff",
    instructions: "Read it all.",
    documents: [{ path: "references/checklist.md", content: "- tests" }],
    origin: {
      repository: "acme/skills",
      branch: "main",
      path: "skills/review",
      commit: listing.commit,
    },
  });

  const again = await Effect.runPromiseExit(
    installer.install({ ...request, paths: ["skills/review"] }),
  );

  expect(JSON.stringify(again)).toContain("already installed");

  const clash = await Effect.runPromiseExit(
    installer.install({ ...request, paths: ["skills/empty"] }),
  );

  expect(JSON.stringify(clash)).toContain("no instructions");
  expect(store.listSkills(null).map((each) => each.name)).toEqual(["review"]);

  const relisted = await run(installer.browse("acme/skills"));

  expect(
    relisted.skills.find((each) => each.path === "skills/review"),
  ).toMatchObject({ status: "installed", skillId: review!.id });
  store.close();
});

test("finds upstream changes to imported files, applies them as a revertible change", async () => {
  const { store, github, installer, run } = setup();
  const listing = await run(installer.browse("acme/skills"));

  const [review] = await run(
    installer.install({
      repository: listing.repository,
      branch: listing.branch,
      commit: listing.commit,
      paths: ["skills/review"],
    }),
  );

  // A changed script isn't imported, so it isn't an update.
  github.push({ ...github.files(), "skills/review/scripts/lint.sh": "echo 2" });
  await run(installer.check());
  expect((await run(installer.updates)).size).toBe(0);

  github.push({
    ...github.files(),
    "skills/review/SKILL.md": skill("review", "Review a diff", "Read twice."),
  });
  expect(await run(installer.check())).toEqual({ failed: [] });

  const update = (await run(installer.updates)).get(review!.id);

  expect(update).toEqual({ commit: expect.any(String), removed: false });
  expect((await run(installer.pending(review!.id))).instructions).toBe(
    "Read twice.",
  );

  const applied = await run(installer.apply(review!.id));

  expect(applied.instructions).toBe("Read twice.");
  expect(applied.origin?.commit).toBe(update!.commit);
  expect((await run(installer.updates)).size).toBe(0);

  const [change] = store.listChanges(null);

  expect(change).toMatchObject({ actor: "owner", action: "update" });
  store.run(
    ChangeReverter.use((r) => r.revert(change!.id, { actor: "owner" })),
  );
  expect(store.getSkill(review!.id)?.instructions).toBe("Read it all.");

  const { "skills/review/SKILL.md": _removed, ...rest } = github.files();
  github.push(rest);
  await run(installer.check());
  expect((await run(installer.updates)).get(review!.id)?.removed).toBe(true);
  store.close();
});

test("a daily check skips skills checked in the last day", async () => {
  const { store, github, installer, run } = setup();
  const listing = await run(installer.browse("acme/skills"));

  await run(
    installer.install({
      repository: listing.repository,
      branch: listing.branch,
      commit: listing.commit,
      paths: ["skills/review"],
    }),
  );

  await run(installer.check(true));
  const calls = github.calls.length;

  await run(installer.check(true));
  expect(github.calls.length).toBe(calls);
  store.close();
});

test("bots and reviews can't change a skill the owner pinned", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-pinned-"));
  dirs.push(dir);
  const store = new Store(dir);

  const agent = store.createAgent({
    name: "A",
    avatar: "bot",
    description: "",
    instructions: "x",
    provider: "openai",
    model: "gpt-4.1",
    enabled: true,
    tools: [],
    skills: [],
    mcpServers: [],
    delegates: [],
  });

  const pinned = store.createSkill({
    agentId: agent.id,
    name: "Pinned",
    description: "",
    instructions: "Keep",
    documents: [],
    pinned: true,
  });

  const skills = standaloneSkills(store);
  const context = { groupId: null, submissionIds: [], runKey: null };

  for (const write of [
    skills.update(
      pinned.id,
      { instructions: "Changed" },
      { ...context, reviewOf: "x" },
    ),
    skills.remove(pinned.id, { ...context, reviewOf: null }),
  ])
    expect(JSON.stringify(Effect.runSyncExit(write))).toContain(
      "pinned by the owner",
    );

  expect(store.getSkill(pinned.id)?.instructions).toBe("Keep");
  store.close();
});
