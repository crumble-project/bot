import { type ReactNode, useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import {
  IconChevronRight,
  IconPencil,
  IconServer,
  IconTrash,
  IconUsersGroup,
} from "@tabler/icons-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
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
  agentPath,
  botsQuery,
  queryClient,
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

const SHARED = "shared";
const ALL = "all";
const DEFAULT = "default";

/** What the page shows: whose skills (all, shared, default, or a bot's id) and the search. */
type SkillFilter = { scope: string; needle: string };

type SharedSkill = Extract<ListedSkill, { source: "shared" }>;

type BundledSkill = Extract<ListedSkill, { source: "bundled" }>;

type BotSkill = Bot["skills"][number];

/** What the dialog edits: a shared skill, one of a bot's own skills by index, or a new one. */
type Editing =
  | { kind: "new" }
  | { kind: "shared"; skill: SharedSkill }
  | { kind: "personal"; bot: Bot; index: number };

async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: skillsQuery.queryKey }),
    queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
  ]);
}

function patchSkills(bot: Bot, skills: BotSkill[]) {
  return send(agentPath(bot.id), "PATCH", { skills });
}

function useRemoveSkills() {
  const shared = useMutation({
    mutationFn: (skill: SharedSkill) =>
      send(`/v1/skills/${encodeURIComponent(skill.id)}`, "DELETE"),
    onSettled: refresh,
  });

  const personal = useMutation({
    mutationFn: ({ bot, index }: { bot: Bot; index: number }) =>
      patchSkills(
        bot,
        bot.skills.filter((_, each) => each !== index),
      ),
    onSettled: refresh,
  });

  return { shared, personal };
}

function SkillPills({
  bots,
  skills,
  scope,
  onScope,
}: {
  bots: Bot[];
  skills: ListedSkill[];
  scope: string;
  onScope: (scope: string) => void;
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
        { value: ALL, label: "All", count: shared + own + bundled },
        {
          value: SHARED,
          label: "Shared",
          icon: <IconUsersGroup />,
          count: shared,
        },
        ...bots.map((bot) => ({
          value: bot.id,
          label: bot.name,
          icon: <BotAvatar bot={bot} size={18} />,
          count: bot.skills.length,
        })),
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
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <RowMenu>
      <DropdownMenuItem onClick={onEdit}>
        <IconPencil />
        Edit
      </DropdownMenuItem>
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
  onOpen,
  expanded,
  actions,
  children,
}: {
  name: string;
  line: string;
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
  deleteDescription,
  onEdit,
  onDelete,
  children,
}: {
  name: string;
  instructions: string;
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
      onOpen={onEdit}
      actions={
        <>
          <SkillMenu onEdit={onEdit} onDelete={() => setDeleting(true)} />
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
const personalEmpty = (bot: Bot, needle: string) => {
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
  bots: Bot[];
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

  if (!owners.length)
    return scope === ALL && !needle ? (
      <Section title="Personal">
        <SectionEmpty>No bot has a skill of its own yet.</SectionEmpty>
      </Section>
    ) : null;

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
      {bot.skills.map((skill, index) =>
        matches(skill, needle) ? (
          <EditableSkillRow
            key={index}
            name={skill.name}
            instructions={skill.instructions}
            deleteDescription={`${bot.name} loses this skill. This cannot be undone.`}
            onEdit={() => onEdit({ kind: "personal", bot, index })}
            onDelete={() => remove.personal.mutate({ bot, index })}
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
}: {
  bots: Bot[];
  skills: ListedSkill[];
  filter: SkillFilter;
  remove: ReturnType<typeof useRemoveSkills>;
  onEdit: (editing: Editing) => void;
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
          {shared.map((skill) => (
            <SharedRow
              key={skill.id}
              skill={skill}
              bots={bots}
              onEdit={() => onEdit({ kind: "shared", skill })}
              onDelete={() => remove.shared.mutate(skill)}
            />
          ))}
        </Section>
      )}
      {ownScope && (
        <PersonalSections
          bots={bots}
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
  skills,
  filter,
  remove,
  onEdit,
}: {
  bots: UseQueryResult<Bot[]>;
  skills: UseQueryResult<ListedSkill[]>;
  filter: SkillFilter;
  remove: ReturnType<typeof useRemoveSkills>;
  onEdit: (editing: Editing) => void;
}) {
  if (skills.isPending || bots.isPending) return <Skeleton className="h-40" />;

  if (skills.isError)
    return (
      <Alert variant="destructive">
        <AlertDescription>{skills.error.message}</AlertDescription>
      </Alert>
    );

  return (
    <SkillSections
      bots={bots.data ?? []}
      skills={(skills.data ?? []).filter((skill) =>
        matches(skill, filter.needle),
      )}
      filter={filter}
      remove={remove}
      onEdit={onEdit}
    />
  );
}

export function SkillsPage() {
  const bots = useQuery(botsQuery);
  const skills = useQuery(skillsQuery);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState(ALL);
  const remove = useRemoveSkills();

  const failure = remove.shared.error ?? remove.personal.error;

  return (
    <WorkspacePage
      title="Skills"
      refreshing={bots.isFetching || skills.isFetching}
      onRefresh={() => void refresh()}
    >
      <div className="flex flex-col gap-3">
        <PageToolbar
          search={search}
          searchLabel="Search skills"
          onSearch={setSearch}
        >
          <NewButton
            label="New skill"
            onClick={() => setEditing({ kind: "new" })}
          />
        </PageToolbar>
        <SkillPills
          bots={bots.data ?? []}
          skills={skills.data ?? []}
          scope={scope}
          onScope={setScope}
        />
      </div>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
      <SkillsBody
        bots={bots}
        skills={skills}
        filter={{ scope, needle: search.trim().toLowerCase() }}
        remove={remove}
        onEdit={setEditing}
      />
      {editing && (
        <SkillDialog
          bots={bots.data ?? []}
          editing={editing}
          onClose={() => setEditing(null)}
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

/** Pressed pills, one per bot, that turn a shared skill on or off for it. */
function BotToggles({ skill, bots }: { skill: SharedSkill; bots: Bot[] }) {
  const assign = useMutation({
    mutationFn: ({ bot, on }: { bot: Bot; on: boolean }) => {
      const others = (bot.sharedSkills ?? []).filter((id) => id !== skill.id);

      return send(agentPath(bot.id), "PATCH", {
        sharedSkills: (on ? [...others, skill.id] : others).toSorted(),
      });
    },
    onSettled: refresh,
  });

  return (
    <>
      <div
        role="group"
        aria-label={`Bots with ${skill.name}`}
        className="flex flex-wrap gap-1.5"
      >
        {bots.map((bot) => {
          const on = bot.sharedSkills?.includes(skill.id) ?? false;

          return (
            <Button
              key={bot.id}
              type="button"
              size="xs"
              variant={on ? "secondary" : "ghost"}
              aria-pressed={on}
              disabled={assign.isPending}
              className={cn(
                "rounded-full border",
                on ? "border-transparent" : "text-muted-foreground",
              )}
              onClick={() => assign.mutate({ bot, on: !on })}
            >
              <BotAvatar
                bot={bot}
                size={14}
                className={cn(!on && "opacity-50 grayscale")}
              />
              {bot.name}
            </Button>
          );
        })}
      </div>
      {assign.isError && (
        <p className="text-sm text-destructive">{assign.error.message}</p>
      )}
    </>
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
      deleteDescription="Every bot that uses it loses it. This cannot be undone."
      onEdit={onEdit}
      onDelete={onDelete}
    >
      {bots.length > 0 && <BotToggles skill={skill} bots={bots} />}
    </EditableSkillRow>
  );
}

function skillDraft(editing: Editing) {
  if (editing.kind === "new")
    return { owner: SHARED, name: "", instructions: "" };

  const skill =
    editing.kind === "shared"
      ? editing.skill
      : editing.bot.skills[editing.index];

  return {
    owner: editing.kind === "personal" ? editing.bot.id : SHARED,
    name: skill?.name ?? "",
    instructions: skill?.instructions ?? "",
  };
}

async function saveSkill(
  editing: Editing,
  bots: Bot[],
  owner: string,
  skill: BotSkill,
) {
  if (editing.kind === "shared")
    return send(
      `/v1/skills/${encodeURIComponent(editing.skill.id)}`,
      "PATCH",
      skill,
    );

  if (editing.kind === "personal")
    return patchSkills(
      editing.bot,
      editing.bot.skills.map((each, index) =>
        index === editing.index ? skill : each,
      ),
    );

  if (owner === SHARED) return send("/v1/skills", "POST", skill);

  const bot = bots.find((each) => each.id === owner);

  if (!bot) throw new Error("Choose a bot.");

  return patchSkills(bot, [...bot.skills, skill]);
}

function SkillDialog({
  bots,
  editing,
  onClose,
}: {
  bots: Bot[];
  editing: Editing;
  onClose: () => void;
}) {
  const initial = skillDraft(editing);
  const [owner, setOwner] = useState(initial.owner);
  const [name, setName] = useState(initial.name);
  const [instructions, setInstructions] = useState(initial.instructions);
  const valid = Boolean(name.trim() && instructions.trim());

  const owners = [
    { label: "Every bot (shared)", value: SHARED },
    ...bots.map((bot) => ({ label: bot.name, value: bot.id })),
  ];

  const save = useMutation({
    mutationFn: () =>
      saveSkill(editing, bots, owner, { name: name.trim(), instructions }),
    onSuccess: async () => {
      await refresh();
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
    </EditorSheet>
  );
}
