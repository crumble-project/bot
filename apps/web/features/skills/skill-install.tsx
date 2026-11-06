import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EditorSheet } from "@/components/form-fields";
import type { Bot } from "@/features/bots/api";
import type { PendingSkillUpdate, SkillListing, SkillPackage } from "./api";
import { api, call, send } from "@/lib/api";
import { StateDiff } from "@/components/state-diff";
import {
  UsedByField,
  assignSharedSkill,
  botsUsing,
  toggled,
} from "./skill-assignment";
import {
  invalidateSkills,
  invalidateSkill,
  skillKey,
  skillUpdateKey,
} from "./skill-cache";
import { MAX_SKILL_NAME_CHARS } from "@crumble/server/contract/limits";
import { type SharedSkill, skillPath } from "./api";

type Candidate = SkillListing["skills"][number];

const STATUS_LABEL: Partial<Record<Candidate["status"], string>> = {
  installed: "Installed",
  update: "Update available",
};

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

function useInstall(
  picked: Set<string>,
  botIds: Set<string>,
  onInstalled: () => void,
) {
  return useMutation({
    mutationFn: (found: SkillListing) =>
      call<"installSkills">("/v1/skills/github/install", "POST", {
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

function useListing(location: string | null) {
  return useQuery({
    queryKey: ["skill-listing", location],
    queryFn: () =>
      call<"browseSkillRepository">("/v1/skills/github/browse", "POST", {
        location: location ?? "",
      }),
    enabled: location !== null,
    retry: false,
  });
}

function useSkillSearch() {
  const [location, setLocation] = useState("");
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string> | null>(null);
  const browse = useListing(submitted);
  const listing = browse.data;
  const picked = checked ?? (listing ? newPaths(listing) : new Set<string>());

  return {
    location,
    browse,
    listing,
    picked,
    find: () => {
      setChecked(null);

      if (submitted === location) void browse.refetch();
      else setSubmitted(location);
    },
    change: (next: string) => {
      setLocation(next);
      setSubmitted(null);
      setChecked(null);
    },
    toggle: (path: string, on: boolean) =>
      setChecked(toggled(picked, path, on)),
  };
}

function sheetAction(
  search: ReturnType<typeof useSkillSearch>,
  install: ReturnType<typeof useInstall>,
) {
  const { listing, picked } = search;
  const idle = !search.browse.isFetching && !install.isPending;

  return listing
    ? {
        label: installLabel(picked.size),
        ready: idle && picked.size > 0,
        run: () => install.mutate(listing),
      }
    : {
        label: "Find skills",
        ready: idle && Boolean(search.location.trim()),
        run: search.find,
      };
}

export function InstallSkillsSheet({
  bots,
  onClose,
}: {
  bots: Bot[];
  onClose: () => void;
}) {
  const search = useSkillSearch();
  const { listing, picked, browse } = search;
  const [botIds, setBotIds] = useState<Set<string>>(new Set());
  const install = useInstall(picked, botIds, onClose);

  const action = sheetAction(search, install);

  return (
    <EditorSheet
      title="Install from GitHub"
      description="Installed skills are shared and read-only. You can update them when the repository changes."
      error={(install.error ?? browse.error)?.message}
      submitLabel={action.label}
      submitDisabled={!action.ready}
      onSubmit={action.run}
      onClose={onClose}
    >
      <RepositoryField
        location={search.location}
        onChange={search.change}
        onFind={listing ? search.find : null}
      />
      {browse.isFetching && !listing && <Skeleton className="h-24" />}
      {listing && (
        <>
          <CandidateList
            listing={listing}
            picked={picked}
            onToggle={search.toggle}
          />
          <UsedByField bots={bots} selected={botIds} onChange={setBotIds} />
        </>
      )}
    </EditorSheet>
  );
}

export async function copySkill(skill: SharedSkill) {
  const full = await api<"getSkill">(skillPath(skill.id));

  await send<"createSkill">("/v1/skills", "POST", {
    name: `${full.name} copy`.slice(0, MAX_SKILL_NAME_CHARS),
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
    api<"getSkill">(skillPath(skillId), { signal }),
});

function useInstalledSkill(
  skill: SharedSkill,
  bots: Bot[],
  onClose: () => void,
) {
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

  return { usedBy, setUsedBy, full, copy, save };
}

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
  const { usedBy, setUsedBy, full, copy, save } = useInstalledSkill(
    skill,
    bots,
    onClose,
  );

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
      api<"pendingSkillUpdate">(`${skillPath(skill.id)}/update`, { signal }),
  });

  const apply = useMutation({
    mutationFn: () =>
      send<"applySkillUpdate">(`${skillPath(skill.id)}/update`, "POST"),
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
