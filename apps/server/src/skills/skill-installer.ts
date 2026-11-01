import { posix } from "node:path";
import { Cause, Clock, Context, Effect, Layer, Schedule } from "effect";
import { GitHubUnavailable } from "../github-apps/github-api";
import { OWNER } from "../shared/change-by";
import type { Skill, SkillDocument, SkillInput } from "../shared/domain";
import {
  Conflict,
  InvalidInput,
  NotFound,
  Unavailable,
} from "../shared/errors";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import {
  GitHubSkillReader,
  MAX_SKILL_FILE_BYTES,
  parseSkillLocation,
  skillDigest,
  skillFiles,
  skillFolders,
  skillFromMarkdown,
  type TreeEntry,
} from "./github-skills";
import { skillUpdates } from "./schema";
import { SkillRepository } from "./skill-repository";

const MAX_LISTED = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_TICK_MS = 60 * 60 * 1000;

/** One skill found in a repository, and whether it can be installed. */
export type SkillCandidate = {
  /** The skill's folder in the repository; empty for the root. */
  path: string;
  name: string;
  description: string;
  status: "new" | "installed" | "update" | "clash" | "invalid";
  /** Why a `clash` or `invalid` skill can't be installed. */
  problem: string | null;
  /** Files in the folder that won't be imported. */
  skipped: string[];
  /** The installed skill, for `installed` and `update`. */
  skillId: string | null;
};

export type SkillListing = {
  repository: string;
  branch: string;
  commit: string;
  path: string;
  skills: SkillCandidate[];
  /** Skills beyond the first hundred, left out of `skills`. */
  omitted: number;
};

export type SkillInstall = {
  repository: string;
  branch: string;
  commit: string;
  paths: string[];
};

/** What an installed skill would become: the upstream skill at `commit`. */
export type PendingSkillUpdate = SkillInput & {
  commit: string;
  skipped: string[];
};

/** An installed skill's upstream moved on; `removed` when its folder is gone. */
export type SkillUpdate = { commit: string; removed: boolean };

export type SkillCheck = {
  failed: { repository: string; branch: string; message: string }[];
};

type Installed = Skill & { origin: NonNullable<Skill["origin"]> };

const isInstalled = (skill: Skill): skill is Installed => skill.origin !== null;

/** Turns GitHub's answers into errors the owner can act on. */
const fromGitHub = (repository: string) => (error: GitHubUnavailable) =>
  error.status === 404
    ? new NotFound({
        message: `Can't find ${repository} on GitHub. Only public repositories can be installed from.`,
      })
    : new Unavailable({ message: error.message });

const nameOf = (repository: string, folder: string) =>
  posix.basename(folder || repository);

/** Installs shared skills from public GitHub repositories and keeps track of their upstream changes. */
export class SkillInstaller extends Context.Service<
  SkillInstaller,
  {
    readonly browse: (
      location: string,
    ) => Effect.Effect<SkillListing, InvalidInput | NotFound | Unavailable>;
    /** Installs every skill in `paths` or none of them. */
    readonly install: (
      request: SkillInstall,
    ) => Effect.Effect<
      Skill[],
      InvalidInput | NotFound | Conflict | Unavailable
    >;
    /** Updates available for installed skills, by skill ID. */
    readonly updates: Effect.Effect<Map<string, SkillUpdate>>;
    /** Checks every installed skill, or only those not checked in the last day when `due`. */
    readonly check: (due?: boolean) => Effect.Effect<SkillCheck>;
    readonly pending: (
      skillId: string,
    ) => Effect.Effect<PendingSkillUpdate, NotFound | Unavailable>;
    /** Replaces the installed skill with its upstream version, recorded as the owner's change. */
    readonly apply: (
      skillId: string,
    ) => Effect.Effect<Skill, NotFound | Conflict | Unavailable>;
  }
>()("crumble/skills/SkillInstaller") {
  static readonly make = Effect.gen(function* () {
    const reader = yield* GitHubSkillReader;
    const skills = yield* SkillRepository;
    const db = yield* ProductDatabase;

    const shared = skills.list(null);

    /** The skill in `folder` at `commit`, fetched with its documents. */
    const fetchSkill = Effect.fnUntraced(function* (
      repository: string,
      commit: string,
      tree: TreeEntry[],
      folder: string,
      withDocuments: boolean,
    ) {
      const files = skillFiles(tree, folder);

      if (!files.main) return { problem: "No SKILL.md", files } as const;

      if ((files.main.size ?? 0) > MAX_SKILL_FILE_BYTES)
        return { problem: "SKILL.md is too large", files } as const;

      const markdown = yield* reader.file(repository, commit, files.main.path);

      const documents: SkillDocument[] = withDocuments
        ? yield* Effect.forEach(
            files.documents,
            (document) =>
              reader.file(repository, commit, document.path).pipe(
                Effect.map((content) => ({
                  path: document.relative,
                  content,
                })),
              ),
            { concurrency: 8 },
          )
        : [];

      const built = skillFromMarkdown(
        nameOf(repository, folder),
        markdown,
        documents,
      );

      return "problem" in built
        ? ({ problem: built.problem, files } as const)
        : ({
            skill: built.skill,
            files,
            digest: skillDigest([files.main, ...files.documents]),
          } as const);
    });

    /** Whether an installed skill or another shared skill already has this folder or name. */
    const statusOf = (
      library: Skill[],
      repository: string,
      folder: string,
      name: string,
      digest: string,
    ): Pick<SkillCandidate, "status" | "problem" | "skillId"> => {
      const same = library.find(
        (skill) =>
          skill.origin?.repository.toLowerCase() === repository.toLowerCase() &&
          skill.origin.path === folder,
      );

      if (same)
        return {
          status: same.origin?.digest === digest ? "installed" : "update",
          problem: null,
          skillId: same.id,
        };

      const named = library.find(
        (skill) => skill.name.toLowerCase() === name.toLowerCase(),
      );

      return named
        ? {
            status: "clash",
            problem: `A shared skill named ${named.name} already exists`,
            skillId: null,
          }
        : { status: "new", problem: null, skillId: null };
    };

    const browse = Effect.fn("SkillInstaller.browse")(function* (
      input: string,
    ) {
      const location = parseSkillLocation(input);

      if (!location)
        return yield* new InvalidInput({
          message: "Enter owner/repo or a github.com URL",
        });

      const { repository } = location;

      const { branch, commit } = yield* reader
        .head(repository, location.branch)
        .pipe(Effect.mapError(fromGitHub(repository)));

      const tree = yield* reader
        .tree(repository, commit)
        .pipe(Effect.mapError(fromGitHub(repository)));

      const folders = skillFolders(tree, location.path);
      const library = yield* shared;

      const candidates = yield* Effect.forEach(
        folders.slice(0, MAX_LISTED),
        (folder) =>
          fetchSkill(repository, commit, tree, folder, false).pipe(
            Effect.map((found): SkillCandidate => {
              const skipped = found.files.skipped;

              if ("problem" in found)
                return {
                  path: folder,
                  name: nameOf(repository, folder),
                  description: "",
                  status: "invalid",
                  problem: found.problem,
                  skipped,
                  skillId: null,
                };

              return {
                path: folder,
                name: found.skill.name,
                description: found.skill.description,
                skipped,
                ...statusOf(
                  library,
                  repository,
                  folder,
                  found.skill.name,
                  found.digest,
                ),
              };
            }),
          ),
        { concurrency: 8 },
      ).pipe(Effect.mapError(fromGitHub(repository)));

      return {
        repository,
        branch,
        commit,
        path: location.path,
        skills: candidates,
        omitted: Math.max(folders.length - MAX_LISTED, 0),
      };
    });

    /** The fetched skills when each can be installed, all under distinct names. */
    const installable = Effect.fnUntraced(function* (
      repository: string,
      fetched: ReadonlyArray<{
        folder: string;
        found: Effect.Success<ReturnType<typeof fetchSkill>>;
      }>,
      library: Skill[],
    ) {
      const names = new Set<string>();
      const ready: { folder: string; skill: SkillInput; digest: string }[] = [];

      for (const { folder, found } of fetched) {
        if ("problem" in found)
          return yield* new InvalidInput({
            message: `${nameOf(repository, folder)}: ${found.problem}`,
          });

        const { skill, digest } = found;
        const key = skill.name.toLowerCase();

        const status = statusOf(
          library,
          repository,
          folder,
          skill.name,
          digest,
        );

        if (status.status !== "new" || names.has(key))
          return yield* new Conflict({
            message: status.problem ?? `${skill.name} is already installed`,
          });
        names.add(key);
        ready.push({ folder, skill, digest });
      }

      return ready;
    });

    const install = Effect.fn("SkillInstaller.install")(function* (
      request: SkillInstall,
    ) {
      const location = parseSkillLocation(request.repository);

      if (!location || location.repository !== request.repository)
        return yield* new InvalidInput({ message: "Invalid repository" });

      const { repository, commit } = request;

      const tree = yield* reader
        .tree(repository, commit)
        .pipe(Effect.mapError(fromGitHub(repository)));

      const folders = new Set(skillFolders(tree, ""));
      const paths = [...new Set(request.paths)];

      const missing = paths.find((path) => !folders.has(path));

      if (missing !== undefined)
        return yield* new NotFound({
          message: `No skill at ${missing || "the repository root"}`,
        });

      const fetched = yield* Effect.forEach(
        paths,
        (folder) =>
          fetchSkill(repository, commit, tree, folder, true).pipe(
            Effect.map((found) => ({ folder, found })),
          ),
        { concurrency: 4 },
      ).pipe(Effect.mapError(fromGitHub(repository)));

      const ready = yield* installable(repository, fetched, yield* shared);

      return yield* db
        .transaction(() =>
          Effect.forEach(ready, ({ folder, skill, digest }) =>
            skills.create({
              ...skill,
              origin: {
                repository,
                branch: request.branch,
                path: folder,
                commit,
                digest,
              },
            }),
          ),
        )
        .pipe(Effect.orDie);
    });

    const rows = db.select().from(skillUpdates).pipe(Effect.orDie);

    const updates = Effect.gen(function* () {
      const byId = new Map((yield* rows).map((row) => [row.skillId, row]));
      const result = new Map<string, SkillUpdate>();

      for (const skill of (yield* shared).filter(isInstalled)) {
        const row = byId.get(skill.id);

        if (row && row.digest !== skill.origin.digest)
          result.set(skill.id, {
            commit: row.commit,
            removed: row.digest === null,
          });
      }

      return result;
    }).pipe(Effect.withSpan("SkillInstaller.updates"));

    const record = Effect.fnUntraced(function* (
      skillId: string,
      commit: string,
      digest: string | null,
    ) {
      const row = { skillId, commit, digest, checkedAt: yield* nowIso };

      yield* db
        .insert(skillUpdates)
        .values(row)
        .onConflictDoUpdate({ target: skillUpdates.skillId, set: row })
        .pipe(Effect.orDie);
    });

    /** Records the upstream state of every skill installed from one branch. */
    const checkBranch = Effect.fnUntraced(function* (group: Installed[]) {
      const { repository, branch } = group[0]!.origin;
      const head = yield* reader.head(repository, branch);

      if (group.every((skill) => skill.origin.commit === head.commit)) {
        for (const skill of group)
          yield* record(skill.id, head.commit, skill.origin.digest);

        return;
      }

      const tree = yield* reader.tree(repository, head.commit);

      for (const skill of group) {
        const files = skillFiles(tree, skill.origin.path);

        yield* record(
          skill.id,
          head.commit,
          files.main ? skillDigest([files.main, ...files.documents]) : null,
        );
      }
    });

    const check = Effect.fn("SkillInstaller.check")(function* (due = false) {
      const now = yield* Clock.currentTimeMillis;

      const checked = new Map(
        (yield* rows).map((row) => [row.skillId, Date.parse(row.checkedAt)]),
      );

      const installed = (yield* shared)
        .filter(isInstalled)
        .filter(
          (skill) => !due || now - (checked.get(skill.id) ?? 0) >= DAY_MS,
        );

      const groups = Map.groupBy(
        installed,
        (skill) =>
          `${skill.origin.repository.toLowerCase()}\0${skill.origin.branch}`,
      );

      const failed: SkillCheck["failed"] = [];

      for (const group of groups.values()) {
        const { repository, branch } = group[0]!.origin;

        yield* checkBranch(group).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              failed.push({ repository, branch, message: error.message }),
            ),
          ),
        );
      }

      return { failed };
    });

    /** The installed skill and its upstream state, when that differs. */
    const upstreamOf = Effect.fnUntraced(function* (skillId: string) {
      const skill = yield* skills.get(skillId);

      if (!skill || !isInstalled(skill))
        return yield* new NotFound({ message: "Installed skill not found" });

      const update = (yield* updates).get(skill.id);

      if (!update || update.removed)
        return yield* new NotFound({
          message: update
            ? `${skill.name} is no longer in ${skill.origin.repository}`
            : `${skill.name} has no update`,
        });

      const { repository, path } = skill.origin;

      const found = yield* reader.tree(repository, update.commit).pipe(
        Effect.flatMap((tree) =>
          fetchSkill(repository, update.commit, tree, path, true),
        ),
        Effect.mapError(fromGitHub(repository)),
      );

      if ("problem" in found)
        return yield* new Unavailable({
          message: `The new version of ${skill.name} can't be installed: ${found.problem}`,
        });

      return { skill, found, commit: update.commit };
    });

    const pending = Effect.fn("SkillInstaller.pending")(function* (
      skillId: string,
    ) {
      const { found, commit } = yield* upstreamOf(skillId);

      return { ...found.skill, commit, skipped: found.files.skipped };
    });

    const apply = Effect.fn("SkillInstaller.apply")(function* (
      skillId: string,
    ) {
      const { skill, found, commit } = yield* upstreamOf(skillId);

      const named = (yield* shared).find(
        (other) =>
          other.id !== skill.id &&
          other.name.toLowerCase() === found.skill.name.toLowerCase(),
      );

      if (named)
        return yield* new Conflict({
          message: `The new version is named ${found.skill.name}, and a shared skill with that name already exists`,
        });

      return (yield* skills.update(
        skill.id,
        {
          ...found.skill,
          origin: { ...skill.origin, commit, digest: found.digest },
        },
        OWNER,
      ))!;
    });

    return SkillInstaller.of({
      browse,
      install,
      updates,
      check,
      pending,
      apply,
    });
  });

  static readonly layer = Layer.effect(SkillInstaller, SkillInstaller.make);
}

/** Checks installed skills hourly for any not checked in the last day, until the layer's scope closes. */
export const skillUpdateChecks = Layer.effectDiscard(
  Effect.gen(function* () {
    const installer = yield* SkillInstaller;

    yield* installer.check(true).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Skill update check failed", Cause.squash(cause)),
      ),
      Effect.repeat(Schedule.spaced(CHECK_TICK_MS)),
      Effect.forkScoped,
    );
  }),
);
