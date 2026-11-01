import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Context, Effect, Layer } from "effect";
import { z } from "zod";
import { github, GitHubUnavailable } from "../github-apps/github-api";
import {
  MAX_SKILL_DOCUMENTS,
  skillDocumentInput,
  skillInput,
  type SkillDocument,
  type SkillInput,
} from "../shared/domain";
import { parseSkillMarkdown } from "./common-skills";

/** Where to look for skills: a repository, optionally a branch, and a folder in it. */
export type SkillLocation = {
  repository: string;
  branch: string | null;
  path: string;
};

const treeEntry = z.object({
  path: z.string(),
  type: z.string(),
  sha: z.string(),
  size: z.number().optional(),
});

export type TreeEntry = z.infer<typeof treeEntry>;

const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

const MAX_DOCUMENT_BYTES = 64000;

/** Same limit as common skills; larger files aren't skill instructions. */
export const MAX_SKILL_FILE_BYTES = 512 * 1024;

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

/** The path segments of a github.com URL, or null for any other address. */
function githubSegments(text: string) {
  const url = URL.parse(text.includes("://") ? text : `https://${text}`);

  return url && GITHUB_HOSTS.has(url.hostname)
    ? url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
    : null;
}

/** The folder a `/tree/` path names, or a `/blob/` path to a SKILL.md lives in. */
const folderIn = (kind: string, path: string) =>
  kind === "blob" && posix.basename(path) === "SKILL.md"
    ? folderOf(path)
    : path;

/** `owner/repo`, or a github.com URL to a repository, a `/tree/<branch>/<folder>`, or a SKILL.md; null otherwise. */
export function parseSkillLocation(input: string): SkillLocation | null {
  const text = input
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");

  if (REPOSITORY.test(text))
    return { repository: text, branch: null, path: "" };

  const [owner = "", repo = "", kind, branch, ...rest] =
    githubSegments(text) ?? [];

  const repository = `${owner}/${repo.replace(/\.git$/, "")}`;

  if (!REPOSITORY.test(repository)) return null;

  if (!kind) return { repository, branch: null, path: "" };

  if (!branch || (kind !== "tree" && kind !== "blob")) return null;

  return { repository, branch, path: folderIn(kind, rest.join("/")) };
}

const folderOf = (file: string) => {
  const folder = posix.dirname(file);

  return folder === "." ? "" : folder;
};

const isInside = (path: string, folder: string) =>
  folder === "" || path === folder || path.startsWith(`${folder}/`);

const IGNORED = new Set(["node_modules", ".git"]);

/** Every folder under `base` with a SKILL.md, shallowest first. */
export function skillFolders(tree: TreeEntry[], base: string) {
  return tree
    .flatMap((entry) =>
      entry.type === "blob" &&
      posix.basename(entry.path) === "SKILL.md" &&
      isInside(folderOf(entry.path), base) &&
      !entry.path.split("/").some((part) => IGNORED.has(part))
        ? [folderOf(entry.path)]
        : [],
    )
    .sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );
}

const isDocumentPath = (path: string) =>
  skillDocumentInput.shape.path.safeParse(path).success;

/** The files of the skill in `folder`: SKILL.md and its reference documents, and the paths left out. */
export function skillFiles(tree: TreeEntry[], folder: string) {
  const nested = skillFolders(tree, folder).filter((other) => other !== folder);

  const files = tree
    .flatMap((entry) =>
      entry.type === "blob" &&
      isInside(entry.path, folder) &&
      !nested.some((other) => isInside(entry.path, other))
        ? [
            {
              ...entry,
              relative: folder
                ? entry.path.slice(folder.length + 1)
                : entry.path,
            },
          ]
        : [],
    )
    .sort((a, b) => a.relative.localeCompare(b.relative));

  const main = files.find((file) => file.relative === "SKILL.md");

  const documents = files
    .filter(
      (file) =>
        isDocumentPath(file.relative) &&
        (file.size ?? 0) > 0 &&
        (file.size ?? 0) <= MAX_DOCUMENT_BYTES,
    )
    .slice(0, MAX_SKILL_DOCUMENTS);

  const imported = new Set([main, ...documents]);

  return {
    main,
    documents,
    skipped: files
      .filter((file) => !imported.has(file))
      .map((file) => file.relative),
  };
}

/** Fingerprint of a skill's imported files at their GitHub blob versions. */
export function skillDigest(
  files: ReadonlyArray<{ relative: string; sha: string }>,
) {
  const hash = createHash("sha256");

  for (const file of [...files].sort((a, b) =>
    a.relative.localeCompare(b.relative),
  ))
    hash.update(`${file.relative}\0${file.sha}\n`);

  return hash.digest("hex");
}

const MAX_DESCRIPTION = 300;
const MAX_NAME = 100;
const MAX_INSTRUCTIONS = 32000;

/** Why a parsed SKILL.md can't be a skill, or null when it can. */
function markdownProblem(
  parsed: ReturnType<typeof parseSkillMarkdown>,
  name: string,
) {
  if (!parsed) return "SKILL.md's frontmatter never closes";

  if (!parsed.body) return "SKILL.md has no instructions";

  if (parsed.body.length > MAX_INSTRUCTIONS)
    return `Its instructions are longer than ${MAX_INSTRUCTIONS.toLocaleString("en")} characters`;

  return name.length > MAX_NAME
    ? `Its name is longer than ${MAX_NAME} characters`
    : null;
}

const shortened = (description: string) =>
  description.length > MAX_DESCRIPTION
    ? `${description.slice(0, MAX_DESCRIPTION - 1).trimEnd()}…`
    : description;

/** The skill a SKILL.md and its documents make, or why they make none. */
export function skillFromMarkdown(
  fallbackName: string,
  markdown: string,
  documents: SkillDocument[],
): { skill: SkillInput } | { problem: string } {
  const parsed = parseSkillMarkdown(markdown);
  const name = parsed?.fields.get("name") ?? fallbackName;
  const problem = markdownProblem(parsed, name);

  if (problem || !parsed) return { problem: problem ?? "Invalid SKILL.md" };

  const result = skillInput.safeParse({
    name,
    description: shortened(parsed.fields.get("description") ?? ""),
    instructions: parsed.body,
    documents,
  });

  return result.success
    ? { skill: result.data }
    : { problem: result.error.issues[0]?.message ?? "Invalid SKILL.md" };
}

const repositoryResponse = z.object({ default_branch: z.string() });

const commitResponse = z.object({ sha: z.string() });

const treeResponse = z.object({
  tree: z.array(treeEntry),
  truncated: z.boolean(),
});

/** Reads public GitHub repositories: a branch's head commit, the file tree at a commit, and single files. */
export class GitHubSkillReader extends Context.Service<
  GitHubSkillReader,
  {
    /** The branch (the default one for `null`) and its newest commit. */
    readonly head: (
      repository: string,
      branch: string | null,
    ) => Effect.Effect<{ branch: string; commit: string }, GitHubUnavailable>;
    readonly tree: (
      repository: string,
      commit: string,
    ) => Effect.Effect<TreeEntry[], GitHubUnavailable>;
    readonly file: (
      repository: string,
      commit: string,
      path: string,
    ) => Effect.Effect<string, GitHubUnavailable>;
  }
>()("crumble/skills/GitHubSkillReader") {
  static readonly layer = Layer.succeed(
    GitHubSkillReader,
    GitHubSkillReader.of({
      head: Effect.fn("GitHubSkillReader.head")(function* (
        repository: string,
        branch: string | null,
      ) {
        const name =
          branch ??
          (yield* github(`/repos/${repository}`, repositoryResponse))
            .default_branch;

        const commit = yield* github(
          `/repos/${repository}/commits/${encodeURIComponent(name)}`,
          commitResponse,
        );

        return { branch: name, commit: commit.sha };
      }),
      tree: Effect.fn("GitHubSkillReader.tree")(function* (
        repository: string,
        commit: string,
      ) {
        const listed = yield* github(
          `/repos/${repository}/git/trees/${commit}?recursive=1`,
          treeResponse,
        );

        if (listed.truncated)
          return yield* new GitHubUnavailable({
            message: "The repository has too many files to list",
          });

        return listed.tree;
      }),
      file: Effect.fn("GitHubSkillReader.file")(function* (
        repository: string,
        commit: string,
        path: string,
      ) {
        const url = `https://raw.githubusercontent.com/${repository}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;

        return yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(url, { signal });

            if (!response.ok) throw new Error(String(response.status));

            return response.text();
          },
          catch: () =>
            new GitHubUnavailable({
              message: `Can't read ${path} from GitHub`,
            }),
        }).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () =>
              Effect.fail(
                new GitHubUnavailable({ message: "GitHub timed out" }),
              ),
          }),
        );
      }),
    }),
  );
}
