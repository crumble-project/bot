import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EditorSheet } from "@/components/form-fields";
import {
  type Bot,
  type ListedSkill,
  type PendingSkillUpdate,
  type SkillListing,
  type SkillPackage,
  api,
  call,
} from "@/lib/api";
import { StateDiff } from "@/features/activity/changes";
import {
  UsedByField,
  assignSharedSkill,
  botsUsing,
  toggled,
} from "./bot-pills";
import {
  invalidateSkills,
  invalidateSkill,
  skillKey,
  skillUpdateKey,
} from "./skill-cache";

type SharedSkill = Extract<ListedSkill, { source: "shared" }>;

type Candidate = SkillListing["skills"][number];

const skillPath = (skillId: string) =>
  `/v1/skills/${encodeURIComponent(skillId)}`;

const STATUS_LABEL: Partial<Record<Candidate["status"], string>> = {
  installed: "Installed",
  update: "Update available",
};

/** Skipped files, the first few by name. */
function skippedNote(skipped: string[]) {
  if (!skipped.length) return null;
  const shown = skipped.slice(0, 3).join(", ");

  return skipped.length > 3
    ? `Skips ${shown} and ${skipped.length - 3} more`
    : `Skips ${shown}`;
}

function CandidateRow({
  candidate,
  checked,
  onChange,
}: {
  candidate: Candidate;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const selectable = candidate.status === "new";
  const note = candidate.problem ?? skippedNote(candidate.skipped);
  const status = STATUS_LABEL[candidate.status];

  return (
    <label
      className={
        selectable
          ? "flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-muted/50"
          : "flex items-start gap-2.5 px-3 py-2 opacity-60"
      }
    >
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
        checked={checked}
        disabled={!selectable}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {candidate.name}
          {status && <Badge variant="outline">{status}</Badge>}
        </span>
        {candidate.description && (
          <span className="text-xs text-muted-foreground">
            {candidate.description}
          </span>
        )}
        {note && (
          <span
            className={
              candidate.problem
                ? "text-xs text-destructive"
                : "text-xs text-muted-foreground"
            }
          >
            {note}
          </span>
        )}
      </span>
    </label>
  );
}

const newPaths = (listing: SkillListing) =>
  new Set(
    listing.skills.flatMap((skill) =>
      skill.status === "new" ? [skill.path] : [],
    ),
  );

const installLabel = (count: number) =>
  `Install ${count} ${count === 1 ? "skill" : "skills"}`;

function RepositoryField({
  location,
  onChange,
  onFind,
}: {
  location: string;
  onChange: (location: string) => void;
  /** Finds again; shown once the first search answered. */
  onFind: (() => void) | null;
}) {
  return (
    <Field>
      <FieldLabel htmlFor="skill-repository">Repository</FieldLabel>
      <div className="flex gap-2">
        <Input
          id="skill-repository"
          placeholder="owner/repo"
          value={location}
          autoFocus
          onChange={(event) => onChange(event.target.value)}
        />
        {onFind && (
          <Button type="button" variant="outline" onClick={onFind}>
            Find
          </Button>
        )}
      </div>
      <FieldDescription>
        A public repository, or a github.com link to a folder in one.
      </FieldDescription>
    </Field>
  );
}

function CandidateList({
  listing,
  picked,
  onToggle,
}: {
  listing: SkillListing;
  picked: Set<string>;
  onToggle: (path: string, on: boolean) => void;
}) {
  return (
    <Field>
      <FieldLabel>
        Skills in {listing.repository} ({listing.branch})
      </FieldLabel>
      {listing.skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No folder here has a SKILL.md.
        </p>
      ) : (
        <div className="flex flex-col divide-y rounded-md border">
          {listing.skills.map((candidate) => (
            <CandidateRow
              key={candidate.path}
              candidate={candidate}
              checked={picked.has(candidate.path)}
              onChange={(on) => onToggle(candidate.path, on)}
            />
          ))}
        </div>
      )}
      {listing.omitted > 0 && (
        <FieldDescription>
          {listing.omitted} more aren't listed. Link to a folder to see them.
        </FieldDescription>
      )}
    </Field>
  );
}

/** Installs the `picked` folders of a listing for `botIds`, then refetches the skill lists. */
function useInstall(
  picked: Set<string>,
  botIds: Set<string>,
  onInstalled: () => void,
) {
  return useMutation({
    mutationFn: (found: SkillListing) =>
      call<SkillPackage[], object>("/v1/skills/github/install", "POST", {
        repository: found.repository,
        branch: found.branch,
        commit: found.commit,
        paths: [...picked],
        botIds: [...botIds],
      }),
    onSuccess: async () => {
      await invalidateSkills();
      onInstalled();
    },
  });
}

/** The skills at `location`, read once it's submitted; a read, so a query rather than a mutation. */
function useListing(location: string | null) {
  return useQuery({
    queryKey: ["skill-listing", location],
    queryFn: () =>
      call<SkillListing, { location: string }>(
        "/v1/skills/github/browse",
        "POST",
        { location: location ?? "" },
      ),
    enabled: location !== null,
    retry: false,
  });
}

/** Finds the skills in a GitHub repository and installs the checked ones as shared skills. */
export function InstallSkillsSheet({
  bots,
  onClose,
}: {
  bots: Bot[];
  onClose: () => void;
}) {
  const [location, setLocation] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  // Null until the owner changes a checkbox: every installable skill starts checked.
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const [botIds, setBotIds] = useState<Set<string>>(new Set());
  const browse = useListing(submitted);
  const listing = browse.data;
  const picked = checked ?? (listing ? newPaths(listing) : new Set<string>());
  const install = useInstall(picked, botIds, onClose);
  const pending = browse.isFetching || install.isPending;

  const find = () => {
    setChecked(null);

    if (submitted === location) void browse.refetch();
    else setSubmitted(location);
  };

  // Before a listing, the sheet's button finds skills; after, it installs the checked ones.
  const action = listing
    ? {
        label: installLabel(picked.size),
        ready: picked.size > 0,
        run: () => install.mutate(listing),
      }
    : {
        label: "Find skills",
        ready: Boolean(location.trim()),
        run: find,
      };

  return (
    <EditorSheet
      title="Install from GitHub"
      description="Installed skills are shared and read-only. You can update them when the repository changes."
      error={(install.error ?? browse.error)?.message}
      submitLabel={action.label}
      submitDisabled={pending || !action.ready}
      onSubmit={action.run}
      onClose={onClose}
    >
      <RepositoryField
        location={location}
        onChange={(next) => {
          setLocation(next);
          setSubmitted(null);
          setChecked(null);
        }}
        onFind={listing ? find : null}
      />
      {browse.isFetching && !listing && <Skeleton className="h-24" />}
      {listing && (
        <>
          <CandidateList
            listing={listing}
            picked={picked}
            onToggle={(path, on) => setChecked(toggled(picked, path, on))}
          />
          <UsedByField bots={bots} selected={botIds} onChange={setBotIds} />
        </>
      )}
    </EditorSheet>
  );
}

/** Creates an editable shared copy of an installed skill, documents included. */
export async function copySkill(skill: SharedSkill) {
  const full = await api<SkillPackage>(skillPath(skill.id));

  await call<SkillPackage, object>("/v1/skills", "POST", {
    name: `${full.name} copy`.slice(0, 100),
    description: full.description,
    instructions: full.instructions,
    documents: full.documents,
  });
}

function SkillSource({
  origin,
}: {
  origin: NonNullable<SharedSkill["origin"]>;
}) {
  const folder = origin.path ? `/tree/${origin.branch}/${origin.path}` : "";

  return (
    <p className="text-sm text-muted-foreground">
      From{" "}
      <a
        className="underline underline-offset-2"
        href={`https://github.com/${origin.repository}${folder}`}
        target="_blank"
        rel="noreferrer"
      >
        {origin.repository}
        {origin.path && `/${origin.path}`}
      </a>{" "}
      on {origin.branch}, commit{" "}
      <span className="font-mono">{origin.commit.slice(0, 7)}</span>.
    </p>
  );
}

function UpdateNotice({
  update,
  onUpdate,
}: {
  update: NonNullable<SharedSkill["update"]>;
  onUpdate: () => void;
}) {
  return (
    <Alert>
      <AlertDescription className="flex items-center justify-between gap-2">
        {update.removed
          ? "This skill is no longer in the repository."
          : "A newer version is available."}
        {!update.removed && (
          <Button type="button" size="sm" onClick={onUpdate}>
            Review update
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** An installed skill's content, read-only. */
function SkillContent({ skill }: { skill: SkillPackage }) {
  return (
    <>
      {skill.description && <p className="text-sm">{skill.description}</p>}
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
        {skill.instructions}
      </pre>
      {skill.documents.length > 0 && (
        <Field>
          <FieldLabel>Reference documents</FieldLabel>
          <ul className="font-mono text-xs text-muted-foreground">
            {skill.documents.map((document) => (
              <li key={document.path}>{document.path}</li>
            ))}
          </ul>
        </Field>
      )}
    </>
  );
}

const fullSkillQuery = (skillId: string) => ({
  queryKey: skillKey(skillId),
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<SkillPackage>(skillPath(skillId), { signal }),
});

/** An installed skill, read-only: its source, content, and a pending update. */
export function InstalledSkillSheet({
  skill,
  bots,
  onUpdate,
  onClose,
}: {
  skill: SharedSkill;
  bots: Bot[];
  onUpdate: () => void;
  onClose: () => void;
}) {
  const [usedBy, setUsedBy] = useState(() => botsUsing(bots, skill.id));
  const full = useQuery(fullSkillQuery(skill.id));

  const done = async () => {
    await invalidateSkills();
    onClose();
  };

  const copy = useMutation({
    mutationFn: () => copySkill(skill),
    onSuccess: done,
  });

  const save = useMutation({
    mutationFn: () => assignSharedSkill(skill.id, bots, usedBy),
    onSuccess: done,
  });

  return (
    <EditorSheet
      title={skill.name}
      description="Installed skills are read-only. Make a copy to change one."
      error={(save.error ?? copy.error ?? full.error)?.message}
      submitLabel="Save"
      submitDisabled={save.isPending}
      onSubmit={() => save.mutate()}
      onClose={onClose}
    >
      <div className="flex items-start justify-between gap-2">
        {skill.origin && <SkillSource origin={skill.origin} />}
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={copy.isPending}
          onClick={() => copy.mutate()}
        >
          Make a copy
        </Button>
      </div>
      <UsedByField bots={bots} selected={usedBy} onChange={setUsedBy} />
      {skill.update && (
        <UpdateNotice update={skill.update} onUpdate={onUpdate} />
      )}
      {full.data ? (
        <SkillContent skill={full.data} />
      ) : (
        full.isPending && <Skeleton className="h-40" />
      )}
    </EditorSheet>
  );
}

function UpdatePreview({
  current,
  pending,
}: {
  current: SkillPackage;
  pending: PendingSkillUpdate;
}) {
  const skipped = skippedNote(pending.skipped);

  return (
    <>
      <StateDiff before={current} after={pending} />
      {skipped && <p className="text-xs text-muted-foreground">{skipped}</p>}
    </>
  );
}

/** The changes an update brings, and applying it. */
export function SkillUpdateSheet({
  skill,
  onClose,
}: {
  skill: SharedSkill;
  onClose: () => void;
}) {
  const current = useQuery(fullSkillQuery(skill.id));

  const pending = useQuery({
    queryKey: skillUpdateKey(skill.id),
    queryFn: ({ signal }) =>
      api<PendingSkillUpdate>(`${skillPath(skill.id)}/update`, { signal }),
  });

  const apply = useMutation({
    mutationFn: () =>
      call<SkillPackage>(`${skillPath(skill.id)}/update`, "POST"),
    onSuccess: async () => {
      await invalidateSkill(skill.id);
      onClose();
    },
  });

  const failure = apply.error ?? pending.error ?? current.error;

  return (
    <EditorSheet
      title={`Update ${skill.name}`}
      description="The update is recorded in the change log, so you can revert it."
      error={failure?.message}
      submitLabel="Update"
      submitDisabled={!pending.data || apply.isPending}
      onSubmit={() => apply.mutate()}
      onClose={onClose}
    >
      {current.data && pending.data ? (
        <UpdatePreview current={current.data} pending={pending.data} />
      ) : (
        !failure && <Skeleton className="h-40" />
      )}
    </EditorSheet>
  );
}
