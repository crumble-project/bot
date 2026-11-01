import { type ReactNode, useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQueries,
  useQuery,
} from "@tanstack/react-query";
import {
  IconBrandGithub,
  IconChevronRight,
  IconCopy,
  IconEye,
  IconPencil,
  IconPin,
  IconPinnedOff,
  IconRefresh,
  IconServer,
  IconTrash,
  IconUsersGroup,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { EditorSheet, OwnerSelectField } from "@/components/form-fields";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  type Bot,
  type ListedSkill,
  type SkillCheck,
  type SkillPackage,
  agentPath,
  api,
  call,
  botsQuery,
  send,
  skillsQuery,
} from "@/lib/api";
import {
  ConfirmDeleteContent,
  FilterPills,
  NewButton,
  PageToolbar,
  RowMenu,
  Section,
  SectionEmpty,
  WorkspacePage,
} from "@/components/workspace";
import { BotAvatar } from "@/features/bots/avatar";
import { cn } from "@/lib/utils";
import { UsedByField, assignSharedSkill, botsUsing } from "./bot-pills";
import { personalSkillsKey, invalidateSkills } from "./skill-cache";
import {
  InstallSkillsSheet,
  InstalledSkillSheet,
  SkillUpdateSheet,
  copySkill,
} from "./skill-install";

const SHARED = "shared";
const ALL = "all";
const DEFAULT = "default";

/** What the page shows: whose skills (all, shared, default, or a bot's id) and the search. */
type SkillFilter = { scope: string; needle: string };

type SharedSkill = Extract<ListedSkill, { source: "shared" }>;

type BundledSkill = Extract<ListedSkill, { source: "bundled" }>;

type BotSkill = {
  id: string;
  name: string;
  instructions: string;
  pinned?: boolean;
};

type SkillBot = Omit<Bot, "skills"> & { skills: BotSkill[] };

const personalSkillPath = (botId: string, skillId: string) =>
  `${agentPath(botId)}/skills/${encodeURIComponent(skillId)}`;

function removePersonalSkill(botId: string, skillId: string) {
  return send(personalSkillPath(botId, skillId), "DELETE");
}

/** The GitHub sheets: installing, viewing an installed skill, or reviewing its update. */
type InstalledSheet =
  | { kind: "install" }
  | { kind: "view"; skill: SharedSkill }
  | { kind: "update"; skill: SharedSkill };

/** What the dialog edits: a shared skill, one of a bot's own skills, or a new one. */
type Editing =
  | { kind: "new" }
  | { kind: "shared"; skill: SharedSkill }
  | { kind: "personal"; bot: SkillBot; skill: BotSkill };

function useRemoveSkills() {
  const shared = useMutation({
    mutationFn: (skill: SharedSkill) =>
      send(`/v1/skills/${encodeURIComponent(skill.id)}`, "DELETE"),
    onSettled: invalidateSkills,
  });

  const personal = useMutation({
    mutationFn: ({ bot, skill }: { bot: SkillBot; skill: BotSkill }) =>
      removePersonalSkill(bot.id, skill.id),
    onSettled: invalidateSkills,
  });

  const pin = useMutation({
    mutationFn: ({ bot, skill }: { bot: SkillBot; skill: BotSkill }) =>
      send(personalSkillPath(bot.id, skill.id), "PATCH", {
        pinned: !skill.pinned,
      }),
    onSettled: invalidateSkills,
  });

  const copy = useMutation({
    mutationFn: copySkill,
    onSettled: invalidateSkills,
  });

  return { shared, personal, pin, copy };
}

function SkillPills({
  bots,
  skills,
  scope,
  onScope,
  unavailable,
}: {
  bots: SkillBot[];
  skills: ListedSkill[];
  scope: string;
  onScope: (scope: string) => void;
  unavailable: Set<string>;
}) {
  const shared = skills.filter((skill) => skill.source === "shared").length;
  const bundled = skills.filter((skill) => skill.source === "bundled").length;
  const own = bots.reduce((sum, bot) => sum + bot.skills.length, 0);

  return (
    <FilterPills
      label="Whose skills"
      value={scope}
      onChange={onScope}
      pills={[
        unavailable.size
          ? { value: ALL, label: "All" }
          : { value: ALL, label: "All", count: shared + own + bundled },
        {
          value: SHARED,
          label: "Shared",
          icon: <IconUsersGroup />,
          count: shared,
        },
        ...bots.map((bot) => {
          const pill = {
            value: bot.id,
            label: bot.name,
            icon: <BotAvatar bot={bot} size={18} />,
          };

          return unavailable.has(bot.id)
            ? pill
            : { ...pill, count: bot.skills.length };
        }),
        {
          value: DEFAULT,
          label: "Default",
          icon: <IconServer />,
          count: bundled,
        },
      ]}
    />
  );
}

/** Whether a skill's name or instructions contain `needle`. */
const matches = (
  skill: { name: string; instructions: string },
  needle: string,
) =>
  !needle ||
  skill.name.toLowerCase().includes(needle) ||
  skill.instructions.toLowerCase().includes(needle);

/** The first line of a skill's instructions, as a glimpse of what it does. */
const glimpse = (instructions: string) =>
  instructions
    .split("\n")
    .map((line) => line.replace(/^#+\s*/, "").trim())
    .find(Boolean) ?? "No instructions.";

function SkillMenu({
  onEdit,
  onDelete,
  items,
}: {
  onEdit: () => void;
  onDelete: () => void;
  items?: ReactNode;
}) {
  return (
    <RowMenu>
      <DropdownMenuItem onClick={onEdit}>
        <IconPencil />
        Edit
      </DropdownMenuItem>
      {items}
      <DropdownMenuSeparator />
      <DropdownMenuItem variant="destructive" onClick={onDelete}>
        <IconTrash />
        Delete
      </DropdownMenuItem>
    </RowMenu>
  );
}

/** A skill row: its name and first line on one line, and what follows on the right. */
function SkillRow({
  name,
  line,
  badge,
  onOpen,
  expanded,
  actions,
  children,
}: {
  name: string;
  line: string;
  badge?: ReactNode;
  onOpen: () => void;
  expanded?: boolean | undefined;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col transition-colors hover:bg-muted/50">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-baseline gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          onClick={onOpen}
        >
          <span className="shrink-0 text-sm font-medium">{name}</span>
          {badge}
          <span className="truncate text-xs text-muted-foreground">{line}</span>
        </button>
        {actions}
      </div>
      {children && (
        <div className="flex flex-col gap-2 px-3 pb-2.5">{children}</div>
      )}
    </div>
  );
}

/** A skill the owner can edit, with Edit and a confirmed Delete in its menu. */
function EditableSkillRow({
  name,
  instructions,
  badge,
  usage,
  menuItems,
  deleteDescription,
  onEdit,
  onDelete,
  children,
}: {
  name: string;
  instructions: string;
  badge?: ReactNode;
  usage?: ReactNode;
  menuItems?: ReactNode;
  deleteDescription: string;
  onEdit: () => void;
  onDelete: () => void;
  children?: ReactNode;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <SkillRow
      name={name}
      line={glimpse(instructions)}
      badge={badge}
      onOpen={onEdit}
      actions={
        <>
          {usage}
          <SkillMenu
            onEdit={onEdit}
            onDelete={() => setDeleting(true)}
            items={menuItems}
          />
          <AlertDialog open={deleting} onOpenChange={setDeleting}>
            <ConfirmDeleteContent
              title={`Delete ${name}?`}
              description={deleteDescription}
              onConfirm={onDelete}
            />
          </AlertDialog>
        </>
      }
    >
      {children}
    </SkillRow>
  );
}

/** The empty note of a bot's own skills: none at all, or none that match. */
const personalEmpty = (bot: SkillBot, needle: string) => {
  if (bot.skills.some((skill) => matches(skill, needle))) return null;

  return bot.skills.length
    ? "No skills match your search."
    : "No skills of its own yet.";
};

function PersonalSections({
  bots,
  filter,
  remove,
  onEdit,
}: {
  bots: SkillBot[];
  filter: SkillFilter;
  remove: ReturnType<typeof useRemoveSkills>;
  onEdit: (editing: Editing) => void;
}) {
  const { scope, needle } = filter;

  // A picked bot shows even when empty; under All, only bots with matching skills do.
  const owners =
    scope === ALL
      ? bots.filter((bot) => bot.skills.some((skill) => matches(skill, needle)))
      : bots.filter((bot) => bot.id === scope);

  if (!owners.length) return null;

  return owners.map((bot) => (
    <Section
      key={bot.id}
      title={bot.name}
      icon={<BotAvatar bot={bot} size={22} />}
      description={`Only ${bot.name} has these.`}
    >
      {personalEmpty(bot, needle) && (
        <SectionEmpty>{personalEmpty(bot, needle)}</SectionEmpty>
      )}
      {bot.skills.map((skill) =>
        matches(skill, needle) ? (
          <EditableSkillRow
            key={skill.id}
            name={skill.name}
            instructions={skill.instructions}
            badge={skill.pinned && <Badge variant="outline">Pinned</Badge>}
            menuItems={
              <DropdownMenuItem
                onClick={() => remove.pin.mutate({ bot, skill })}
              >
                {skill.pinned ? <IconPinnedOff /> : <IconPin />}
                {skill.pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
            }
            deleteDescription={`${bot.name} loses this skill. This cannot be undone.`}
            onEdit={() => onEdit({ kind: "personal", bot, skill })}
            onDelete={() => remove.personal.mutate({ bot, skill })}
          />
        ) : null,
      )}
    </Section>
  ));
}

function SkillSections({
  bots,
  skills,
  filter,
  remove,
  onEdit,
  onInstalled,
  unavailable,
}: {
  bots: SkillBot[];
  skills: ListedSkill[];
  filter: SkillFilter;
  remove: ReturnType<typeof useRemoveSkills>;
  onEdit: (editing: Editing) => void;
  onInstalled: (sheet: InstalledSheet) => void;
  unavailable: Set<string>;
}) {
  const bundled = skills.flatMap((skill) =>
    skill.source === "bundled" ? [skill] : [],
  );

  const shared = skills.flatMap((skill) =>
    skill.source === "shared" ? [skill] : [],
  );

  const shows = (scope: string) =>
    filter.scope === ALL || filter.scope === scope;

  const ownScope = filter.scope !== SHARED && filter.scope !== DEFAULT;

  return (
    <>
      {shows(SHARED) && (
        <Section
          title="Shared"
          description="Turn a shared skill on for the bots that should have it."
        >
          {shared.length === 0 && (
            <SectionEmpty>No shared skills yet.</SectionEmpty>
          )}
          {shared.map((skill) =>
            skill.origin ? (
              <InstalledRow
                key={skill.id}
                skill={skill}
                bots={bots}
                onView={() => onInstalled({ kind: "view", skill })}
                onUpdate={() => onInstalled({ kind: "update", skill })}
                onCopy={() => remove.copy.mutate(skill)}
                onDelete={() => remove.shared.mutate(skill)}
              />
            ) : (
              <SharedRow
                key={skill.id}
                skill={skill}
                bots={bots}
                onEdit={() => onEdit({ kind: "shared", skill })}
                onDelete={() => remove.shared.mutate(skill)}
              />
            ),
          )}
        </Section>
      )}
      {ownScope && (
        <PersonalSections
          bots={bots.filter((bot) => !unavailable.has(bot.id))}
          filter={filter}
          remove={remove}
          onEdit={onEdit}
        />
      )}
      {shows(DEFAULT) && (
        <Section
          title="Default"
          description="Every bot has these. They're files on the server: edit them there and restart it."
        >
          {bundled.length === 0 && (
            <SectionEmpty>No default skills.</SectionEmpty>
          )}
          {bundled.map((skill) => (
            <BundledRow key={skill.id} skill={skill} />
          ))}
        </Section>
      )}
    </>
  );
}

function SkillsBody({
  bots,
  skillBots,
  personalPending,
  personalErrors,
  skills,
  filter,
  remove,
  onEdit,
  onInstalled,
}: {
  bots: UseQueryResult<Bot[]>;
  skillBots: SkillBot[];
  personalPending: boolean;
  personalErrors: { bot: Bot; error: Error }[];
  skills: UseQueryResult<ListedSkill[]>;
  filter: SkillFilter;
  remove: ReturnType<typeof useRemoveSkills>;
  onEdit: (editing: Editing) => void;
  onInstalled: (sheet: InstalledSheet) => void;
}) {
  if (skills.isPending || bots.isPending || personalPending)
    return <Skeleton className="h-40" />;

  if (bots.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{bots.error.message}</AlertDescription>
      </Alert>
    );

  if (skills.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{skills.error.message}</AlertDescription>
      </Alert>
    );

  return (
    <>
      {personalErrors.map(({ bot, error }) => (
        <Alert key={bot.id} variant="destructive">
          <AlertDescription>
            Could not load {bot.name}'s skills: {error.message}
          </AlertDescription>
        </Alert>
      ))}
      <SkillSections
        bots={skillBots}
        skills={(skills.data ?? []).filter((skill) =>
          matches(skill, filter.needle),
        )}
        filter={filter}
        remove={remove}
        onEdit={onEdit}
        onInstalled={onInstalled}
        unavailable={new Set(personalErrors.map(({ bot }) => bot.id))}
      />
    </>
  );
}

/** Every bot with its personal skills, and the bots whose skills failed to load. */
function usePersonalSkills() {
  const bots = useQuery(botsQuery);
  const list = bots.data ?? [];

  const personal = useQueries({
    queries: list.map((bot) => ({
      queryKey: [...personalSkillsKey, bot.id],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<BotSkill[]>(`${agentPath(bot.id)}/skills`, { signal }),
    })),
  });

  const skillBots = list.map((bot, index) => ({
    ...bot,
    skills: personal[index]?.data ?? [],
  }));

  const personalErrors = list.flatMap((bot, index) => {
    const query = personal[index];

    return query?.isError ? [{ bot, error: query.error }] : [];
  });

  return { bots, personal, skillBots, personalErrors };
}

function useUpdateCheck() {
  return useMutation({
    mutationFn: () => call<SkillCheck>("/v1/skills/updates/check", "POST"),
    onSettled: invalidateSkills,
  });
}

/** Checks installed skills for updates now; shown only when any skill is installed. */
function UpdateCheckButton({
  skills,
  check,
}: {
  skills: ListedSkill[];
  check: ReturnType<typeof useUpdateCheck>;
}) {
  const installed = skills.some(
    (skill) => skill.source === "shared" && skill.origin,
  );

  return installed ? (
    <Button
      variant="outline"
      disabled={check.isPending}
      onClick={() => check.mutate()}
    >
      <IconRefresh data-icon="inline-start" />
      Check for updates
    </Button>
  ) : null;
}

function UpdateCheckFailures({
  check,
}: {
  check: ReturnType<typeof useUpdateCheck>;
}) {
  const failures = [
    ...(check.error ? [check.error.message] : []),
    ...(check.data?.failed ?? []).map(
      (failed) =>
        `Couldn't check ${failed.repository} (${failed.branch}): ${failed.message}`,
    ),
  ];

  return failures.length ? (
    <Alert variant="destructive">
      <AlertDescription>{failures.join(" ")}</AlertDescription>
    </Alert>
  ) : null;
}

/** The open GitHub sheet: installing, an installed skill, or its update. */
function InstalledSheets({
  sheet,
  bots,
  onSheet,
}: {
  sheet: InstalledSheet;
  bots: SkillBot[];
  onSheet: (sheet: InstalledSheet | null) => void;
}) {
  const close = () => onSheet(null);

  switch (sheet.kind) {
    case "install":
      return <InstallSkillsSheet bots={bots} onClose={close} />;
    case "view":
      return (
        <InstalledSkillSheet
          skill={sheet.skill}
          bots={bots}
          onUpdate={() => onSheet({ kind: "update", skill: sheet.skill })}
          onClose={close}
        />
      );
    case "update":
      return <SkillUpdateSheet skill={sheet.skill} onClose={close} />;
  }
}

const firstError = (remove: ReturnType<typeof useRemoveSkills>) =>
  remove.shared.error ??
  remove.personal.error ??
  remove.pin.error ??
  remove.copy.error;

export function SkillsPage() {
  const { bots, personal, skillBots, personalErrors } = usePersonalSkills();
  const skills = useQuery(skillsQuery);

  const unavailable = new Set(personalErrors.map(({ bot }) => bot.id));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [installed, setInstalled] = useState<InstalledSheet | null>(null);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState(ALL);
  const remove = useRemoveSkills();
  const check = useUpdateCheck();
  const failure = firstError(remove);

  return (
    <WorkspacePage
      title="Skills"
      refreshing={
        bots.isFetching ||
        skills.isFetching ||
        personal.some((query) => query.isFetching)
      }
      onRefresh={() => void invalidateSkills()}
    >
      <div className="flex flex-col gap-3">
        <PageToolbar
          search={search}
          searchLabel="Search skills"
          onSearch={setSearch}
        >
          <UpdateCheckButton skills={skills.data ?? []} check={check} />
          <Button
            variant="outline"
            onClick={() => setInstalled({ kind: "install" })}
          >
            <IconBrandGithub data-icon="inline-start" />
            Install from GitHub
          </Button>
          <NewButton
            label="New skill"
            onClick={() => setEditing({ kind: "new" })}
          />
        </PageToolbar>
        <SkillPills
          bots={skillBots}
          skills={skills.data ?? []}
          scope={scope}
          onScope={setScope}
          unavailable={unavailable}
        />
      </div>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
      <UpdateCheckFailures check={check} />
      <SkillsBody
        bots={bots}
        skillBots={skillBots}
        personalPending={personal.some((query) => query.isPending)}
        personalErrors={personalErrors}
        skills={skills}
        filter={{ scope, needle: search.trim().toLowerCase() }}
        remove={remove}
        onEdit={setEditing}
        onInstalled={setInstalled}
      />
      {editing && (
        <SkillDialog
          bots={skillBots}
          editing={editing}
          onClose={() => setEditing(null)}
        />
      )}
      {installed && (
        <InstalledSheets
          sheet={installed}
          bots={skillBots}
          onSheet={setInstalled}
        />
      )}
    </WorkspacePage>
  );
}

function BundledRow({ skill }: { skill: BundledSkill }) {
  const [open, setOpen] = useState(false);

  return (
    <SkillRow
      name={skill.name}
      line={skill.description || glimpse(skill.instructions)}
      expanded={open}
      onOpen={() => setOpen(!open)}
      actions={
        <IconChevronRight
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      }
    >
      {open && (
        <>
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">
            {skill.instructions || "No instructions."}
          </p>
          <span className="font-mono text-xs text-muted-foreground">
            {skill.path}
          </span>
        </>
      )}
    </SkillRow>
  );
}

/** "(used by N)" after a shared skill's line, when any bot uses it. */
function UsedBy({ bots, skillId }: { bots: Bot[]; skillId: string }) {
  const count = botsUsing(bots, skillId).size;

  return count ? (
    <span className="shrink-0 text-xs text-muted-foreground">
      (used by {count})
    </span>
  ) : null;
}

/** An installed skill: read-only, so View instead of Edit, plus Update and Make a copy. */
function InstalledRow({
  skill,
  bots,
  onView,
  onUpdate,
  onCopy,
  onDelete,
}: {
  skill: SharedSkill;
  bots: Bot[];
  onView: () => void;
  onUpdate: () => void;
  onCopy: () => void;
  onDelete: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const update = skill.update;

  return (
    <SkillRow
      name={skill.name}
      line={skill.description || glimpse(skill.instructions)}
      badge={
        update && (
          <Badge variant={update.removed ? "outline" : "secondary"}>
            {update.removed ? "Removed upstream" : "Update available"}
          </Badge>
        )
      }
      onOpen={onView}
      actions={
        <>
          <UsedBy bots={bots} skillId={skill.id} />
          <RowMenu>
            <DropdownMenuItem onClick={onView}>
              <IconEye />
              View
            </DropdownMenuItem>
            {update && !update.removed && (
              <DropdownMenuItem onClick={onUpdate}>
                <IconRefresh />
                Update
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={onCopy}>
              <IconCopy />
              Make a copy
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setDeleting(true)}
            >
              <IconTrash />
              Uninstall
            </DropdownMenuItem>
          </RowMenu>
          <AlertDialog open={deleting} onOpenChange={setDeleting}>
            <ConfirmDeleteContent
              title={`Uninstall ${skill.name}?`}
              description="Every bot that uses it loses it. You can install it again from GitHub."
              onConfirm={onDelete}
            />
          </AlertDialog>
        </>
      }
    />
  );
}

function SharedRow({
  skill,
  bots,
  onEdit,
  onDelete,
}: {
  skill: SharedSkill;
  bots: Bot[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <EditableSkillRow
      name={skill.name}
      instructions={skill.instructions}
      usage={<UsedBy bots={bots} skillId={skill.id} />}
      deleteDescription="Every bot that uses it loses it. This cannot be undone."
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

function skillDraft(editing: Editing) {
  if (editing.kind === "new")
    return { owner: SHARED, name: "", instructions: "" };

  const skill = editing.skill;

  return {
    owner: editing.kind === "personal" ? editing.bot.id : SHARED,
    name: skill?.name ?? "",
    instructions: skill?.instructions ?? "",
  };
}

async function saveSkill(
  editing: Editing,
  bots: SkillBot[],
  owner: string,
  skill: { name: string; instructions: string },
) {
  if (editing.kind === "shared") {
    await send(
      `/v1/skills/${encodeURIComponent(editing.skill.id)}`,
      "PATCH",
      skill,
    );

    return editing.skill.id;
  }

  if (editing.kind === "personal") {
    await send(
      personalSkillPath(editing.bot.id, editing.skill.id),
      "PATCH",
      skill,
    );

    return null;
  }

  if (owner === SHARED)
    return (await call<SkillPackage, typeof skill>("/v1/skills", "POST", skill))
      .id;

  const bot = bots.find((each) => each.id === owner);

  if (!bot) throw new Error("Choose a bot.");
  await send(`${agentPath(bot.id)}/skills`, "POST", skill);

  return null;
}

function SkillDialog({
  bots,
  editing,
  onClose,
}: {
  bots: SkillBot[];
  editing: Editing;
  onClose: () => void;
}) {
  const initial = skillDraft(editing);
  const [owner, setOwner] = useState(initial.owner);
  const [name, setName] = useState(initial.name);
  const [instructions, setInstructions] = useState(initial.instructions);

  const [usedBy, setUsedBy] = useState(() =>
    editing.kind === "shared"
      ? botsUsing(bots, editing.skill.id)
      : new Set<string>(),
  );

  const valid = Boolean(name.trim() && instructions.trim());

  const owners = [
    { label: "Every bot (shared)", value: SHARED },
    ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  const save = useMutation({
    mutationFn: async () => {
      const sharedId = await saveSkill(editing, bots, owner, {
        name: name.trim(),
        instructions,
      });

      if (sharedId) await assignSharedSkill(sharedId, bots, usedBy);
    },
    onSuccess: async () => {
      await invalidateSkills();
      onClose();
    },
  });

  return (
    <EditorSheet
      title={editing.kind === "new" ? "New Skill" : "Edit Skill"}
      error={save.error?.message}
      submitLabel={editing.kind === "new" ? "Add" : "Save"}
      submitDisabled={!valid || save.isPending}
      onSubmit={() => valid && save.mutate()}
      onClose={onClose}
    >
      <OwnerSelectField
        label="Available to"
        owners={owners}
        value={owner}
        disabled={editing.kind !== "new"}
        onValueChange={(value) => setOwner(value ?? SHARED)}
      />
      <Field>
        <FieldLabel htmlFor="skill-name">Name</FieldLabel>
        <Input
          id="skill-name"
          maxLength={100}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="skill-instructions">Instructions</FieldLabel>
        <Textarea
          id="skill-instructions"
          className="min-h-40"
          maxLength={32000}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </Field>
      {owner === SHARED && (
        <UsedByField bots={bots} selected={usedBy} onChange={setUsedBy} />
      )}
    </EditorSheet>
  );
}
