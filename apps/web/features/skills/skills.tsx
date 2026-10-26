import { type ReactNode, useState } from "react";
import {
  type UseQueryResult,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { OwnerSelectField, SaveDialogFooter } from "@/components/form-fields";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
  ConfirmDelete,
  Section,
  SectionEmpty,
  WorkspacePage,
} from "@/components/workspace";

const SHARED = "shared";

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

function PersonalRow({
  bot,
  skill,
  onEdit,
  onDelete,
}: {
  bot: Bot;
  skill: BotSkill;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-start gap-2 p-3">
      <Expandable
        title={skill.name}
        subtitle={`Only ${bot.name}`}
        body={skill.instructions}
      />
      <Button variant="ghost" size="icon-sm" title="Edit" onClick={onEdit}>
        <HugeiconsIcon icon={PencilEdit01Icon} />
      </Button>
      <ConfirmDelete
        title={`Delete ${skill.name}?`}
        description={`${bot.name} loses this skill. This cannot be undone.`}
        onConfirm={onDelete}
        trigger={
          <Button variant="ghost" size="icon-sm" title="Delete">
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        }
      />
    </div>
  );
}

function SkillSections({
  bots,
  skills,
  remove,
  onEdit,
}: {
  bots: Bot[];
  skills: ListedSkill[];
  remove: ReturnType<typeof useRemoveSkills>;
  onEdit: (editing: Editing) => void;
}) {
  const bundled = skills.flatMap((skill) =>
    skill.source === "bundled" ? [skill] : [],
  );

  const shared = skills.flatMap((skill) =>
    skill.source === "shared" ? [skill] : [],
  );

  const personal = bots.flatMap((bot) =>
    bot.skills.map((skill, index) => ({ bot, skill, index })),
  );

  return (
    <>
      <Section
        title="Default · Every bot"
        footer="Default skills are files on the server. Edit them there and restart the server."
      >
        {bundled.length === 0 && (
          <SectionEmpty>No default skills.</SectionEmpty>
        )}
        {bundled.map((skill) => (
          <BundledRow key={skill.id} skill={skill} />
        ))}
      </Section>
      <Section title="Shared">
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
      <Section title="Personal">
        {personal.length === 0 && (
          <SectionEmpty>No personal skills yet.</SectionEmpty>
        )}
        {personal.map(({ bot, skill, index }) => (
          <PersonalRow
            key={`${bot.id}:${index}`}
            bot={bot}
            skill={skill}
            onEdit={() => onEdit({ kind: "personal", bot, index })}
            onDelete={() => remove.personal.mutate({ bot, index })}
          />
        ))}
      </Section>
    </>
  );
}

function SkillsBody({
  bots,
  skills,
  remove,
  onEdit,
}: {
  bots: UseQueryResult<Bot[]>;
  skills: UseQueryResult<ListedSkill[]>;
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
      skills={skills.data ?? []}
      remove={remove}
      onEdit={onEdit}
    />
  );
}

export function SkillsPage() {
  const bots = useQuery(botsQuery);
  const skills = useQuery(skillsQuery);
  const [editing, setEditing] = useState<Editing | null>(null);
  const remove = useRemoveSkills();

  const failure = remove.shared.error ?? remove.personal.error;

  return (
    <WorkspacePage
      title="Skills"
      refreshing={bots.isFetching || skills.isFetching}
      onRefresh={() => void refresh()}
      newLabel="New skill"
      onNew={() => setEditing({ kind: "new" })}
    >
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      )}
      <SkillsBody
        bots={bots}
        skills={skills}
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

function Expandable({
  title,
  subtitle,
  body,
  children,
}: {
  title: string;
  subtitle: string;
  body: string;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Icon = open ? ArrowDown01Icon : ArrowRight01Icon;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <button
        type="button"
        className="flex items-start gap-1.5 text-left"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <HugeiconsIcon
          icon={Icon}
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{title}</span>
          <span className="text-xs text-muted-foreground">{subtitle}</span>
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 pl-5.5">
          <p className="text-sm whitespace-pre-wrap text-muted-foreground">
            {body || "No instructions."}
          </p>
          {children}
        </div>
      )}
    </div>
  );
}

function BundledRow({ skill }: { skill: BundledSkill }) {
  return (
    <div className="flex p-3">
      <Expandable
        title={skill.name}
        subtitle={`Source: ${skill.path}`}
        body={skill.instructions}
      />
    </div>
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
  const users = bots.flatMap((bot) =>
    bot.sharedSkills?.includes(skill.id) ? [bot.name] : [],
  );

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
    <div className="flex items-start gap-2 p-3">
      <Expandable
        title={skill.name}
        subtitle={
          users.length ? `Enabled for: ${users.join(", ")}` : "No bots enabled"
        }
        body={skill.instructions}
      >
        <FieldSet>
          <FieldLegend variant="label">Assign to bots</FieldLegend>
          <FieldGroup className="gap-2">
            {bots.map((bot) => (
              <Field key={bot.id} orientation="horizontal">
                <Switch
                  id={`${skill.id}-${bot.id}`}
                  checked={bot.sharedSkills?.includes(skill.id) ?? false}
                  disabled={assign.isPending}
                  onCheckedChange={(on) => assign.mutate({ bot, on })}
                />
                <FieldLabel htmlFor={`${skill.id}-${bot.id}`}>
                  {bot.name}
                </FieldLabel>
              </Field>
            ))}
          </FieldGroup>
        </FieldSet>
        {assign.isError && (
          <p className="text-sm text-destructive">{assign.error.message}</p>
        )}
      </Expandable>
      <Button variant="ghost" size="icon-sm" title="Edit" onClick={onEdit}>
        <HugeiconsIcon icon={PencilEdit01Icon} />
      </Button>
      <ConfirmDelete
        title={`Delete ${skill.name}?`}
        description="Every bot that uses it loses it. This cannot be undone."
        onConfirm={onDelete}
        trigger={
          <Button variant="ghost" size="icon-sm" title="Delete">
            <HugeiconsIcon icon={Delete02Icon} />
          </Button>
        }
      />
    </div>
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
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing.kind === "new" ? "New Skill" : "Edit Skill"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();

            if (valid) save.mutate();
          }}
        >
          <FieldGroup>
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
            <SaveDialogFooter
              error={save.isError ? save.error : null}
              onCancel={onClose}
              disabled={!valid || save.isPending}
              label={editing.kind === "new" ? "Add" : "Save"}
            />
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
