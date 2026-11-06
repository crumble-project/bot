import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
} from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { IconX } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { EditorSheet } from "@/components/form-fields";
import { ConfirmDeleteContent } from "@/components/page";
import type { Bot } from "@/features/bots/api";
import { cn } from "@/lib/utils";
import { BotToggles, toggled } from "./skill-assignment";
import { invalidateSkills } from "./skill-cache";
import {
  applyBulkAction,
  skillLabel,
  type BulkAction,
  type BulkMessage,
  type SelectableSkill,
} from "./bulk-skill-actions";

type Selection = {
  selected: Set<string>;
  change: (ids: string[], on: boolean) => void;
  busy: boolean;
};

const SelectionContext = createContext<Selection | null>(null);

const SHOWN = {
  row: "opacity-0 group-hover/row:opacity-100 group-data-selecting/skills:opacity-100 focus-visible:opacity-100 checked:opacity-100 [@media(hover:none)]:opacity-100",
  section:
    "opacity-0 group-hover/section:opacity-100 group-data-selecting/skills:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100",
  all: "",
};

/** Native checkboxes keep keyboard interaction and mixed section selection accessible. */
export function SelectSkills({
  ids,
  label,
  place = "row",
}: {
  ids: string[];
  label: string;
  place?: keyof typeof SHOWN;
}) {
  const selection = useContext(SelectionContext);
  const id = useId();

  if (!selection || !ids.length) return null;
  const count = ids.filter((id) => selection.selected.has(id)).length;

  const box = (
    <input
      id={id}
      type="checkbox"
      className={cn("checkbox", place === "row" && SHOWN.row)}
      aria-label={label}
      aria-checked={
        count && count < ids.length ? "mixed" : count === ids.length
      }
      ref={(node) => {
        if (node) node.indeterminate = count > 0 && count < ids.length;
      }}
      checked={count === ids.length}
      disabled={selection.busy}
      onChange={(event) => selection.change(ids, event.target.checked)}
    />
  );

  if (place === "row") return box;

  return (
    <label
      htmlFor={id}
      className={cn(
        "flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground transition-opacity hover:text-foreground",
        SHOWN[place],
      )}
    >
      {box}
      Select all
    </label>
  );
}

const ACTIONS: { action: BulkAction; label: string }[] = [
  { action: "update", label: "Update" },
  { action: "assign", label: "Assign to bots" },
  { action: "remove", label: "Remove from bots" },
  { action: "delete", label: "Delete" },
];

function BulkActionRow({
  count,
  busy,
  disabled,
  onAction,
  onClear,
}: {
  count: number;
  busy: boolean;
  disabled: Set<BulkAction>;
  onAction: (action: BulkAction) => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        className="rounded-full"
        title="Clear selection"
        disabled={busy}
        onClick={onClear}
      >
        <IconX />
      </Button>
      <p className="pr-2 text-sm font-medium tabular-nums">{count} selected</p>
      {ACTIONS.map(({ action, label }) => (
        <Button
          key={action}
          size="sm"
          variant="ghost"
          className={cn(
            "rounded-full",
            action === "delete" &&
              "text-destructive hover:bg-destructive/10 hover:text-destructive",
          )}
          disabled={busy || disabled.has(action)}
          onClick={() => onAction(action)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}

function BulkActionBar({
  picked,
  busy,
  hasBots,
  onAction,
  onClear,
}: {
  picked: SelectableSkill[];
  busy: boolean;
  hasBots: boolean;
  onAction: (action: BulkAction) => void;
  onClear: () => void;
}) {
  const notInstalled = picked.filter((skill) => !skill.installed);
  const disabled = new Set<BulkAction>();

  if (notInstalled.length === picked.length) disabled.add("update");

  if (!hasBots) {
    disabled.add("assign");
    disabled.add("remove");
  }

  return (
    <div
      className="sticky bottom-4 z-10 mx-auto flex max-w-full animate-in flex-col gap-1.5 rounded-[22px] border bg-popover/95 p-1.5 text-popover-foreground shadow-lg backdrop-blur duration-200 fade-in slide-in-from-bottom-2"
      aria-label="Selected skills"
    >
      <BulkActionRow
        count={picked.length}
        busy={busy}
        disabled={disabled}
        onAction={onAction}
        onClear={onClear}
      />
      {notInstalled.length > 0 && (
        <p className="px-3 pb-1 text-xs text-muted-foreground">
          Update skips skills not installed from GitHub:{" "}
          {notInstalled.map(skillLabel).join(", ")}.
        </p>
      )}
      {busy && (
        <p role="status" className="px-3 pb-1 text-xs text-muted-foreground">
          Applying action…
        </p>
      )}
    </div>
  );
}

function BotTargetsSheet({
  action,
  bots,
  picked,
  targets,
  busy,
  onTargets,
  onSubmit,
  onClose,
}: {
  action: "assign" | "remove";
  bots: Bot[];
  picked: SelectableSkill[];
  targets: Set<string>;
  busy: boolean;
  onTargets: (targets: Set<string>) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const assign = action === "assign";

  return (
    <EditorSheet
      title={assign ? "Assign to bots" : "Remove from bots"}
      submitLabel={assign ? "Assign" : "Remove"}
      submitDisabled={!targets.size || busy}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <p className="text-sm">
        {assign
          ? "Shared skills are enabled. Bot-specific skills are copied; existing linked copies and their edits are kept."
          : "Shared skills are disabled. Only linked bot-specific copies are deleted, including edited copies; same-name skills and the original are kept."}
      </p>
      <p className="text-sm">{picked.map(skillLabel).join(", ")}</p>
      <BotToggles
        label="Choose bots"
        bots={bots}
        isOn={(bot) => targets.has(bot.id)}
        onToggle={(bot, on) => onTargets(toggled(targets, bot.id, on))}
      />
    </EditorSheet>
  );
}

function useCheckedSkills() {
  const [selected, setSelected] = useState(new Set<string>());

  const change = useCallback((ids: string[], on: boolean) => {
    setSelected((old) => {
      const next = new Set(old);

      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }

      return next;
    });
  }, []);

  return { selected, setSelected, change };
}

function useBulkSkills(bots: Bot[], skills: SelectableSkill[]) {
  const { selected, setSelected, change } = useCheckedSkills();
  const [dialog, setDialog] = useState<BulkAction | null>(null);
  const [targets, setTargets] = useState(new Set<string>());
  const [report, setReport] = useState<BulkMessage[]>([]);
  const picked = skills.filter((skill) => selected.has(skill.id));

  const bulk = useMutation({
    mutationFn: async (action: BulkAction) => {
      const result = await applyBulkAction(
        action,
        picked,
        bots.filter((bot) => targets.has(bot.id)),
      );

      setSelected(result.failed);
      setReport(result.messages);
      await invalidateSkills();
    },
  });

  const selection = useMemo<Selection>(
    () => ({ selected, busy: bulk.isPending, change }),
    [selected, bulk.isPending, change],
  );

  const run = (action: BulkAction) => {
    setDialog(null);
    setReport([]);
    bulk.mutate(action);
  };

  const start = (action: BulkAction) => {
    if (action === "update") run(action);
    else {
      setTargets(new Set());
      setDialog(action);
    }
  };

  return {
    selection,
    picked,
    busy: bulk.isPending,
    dialog,
    setDialog,
    targets,
    setTargets,
    report,
    run,
    start,
    clear: () => setSelected(new Set()),
  };
}

function BulkReport({ report }: { report: BulkMessage[] }) {
  if (!report.length) return null;

  return (
    <Alert>
      <AlertDescription>
        <ul aria-label="Bulk action results">
          {report.map((line) => (
            <li key={line.id}>{line.text}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

function BulkDialogs({
  bots,
  bulk: { picked, busy, dialog, setDialog, targets, setTargets, run },
}: {
  bots: Bot[];
  bulk: ReturnType<typeof useBulkSkills>;
}) {
  return (
    <>
      <AlertDialog
        open={dialog === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <ConfirmDeleteContent
          title={`Delete ${picked.length} skills?`}
          description={`Delete: ${picked.map(skillLabel).join(", ")}. Shared skills are removed from every bot. Existing bot-specific copies are kept. This cannot be undone here.`}
          onConfirm={() => run("delete")}
        />
      </AlertDialog>
      {(dialog === "assign" || dialog === "remove") && (
        <BotTargetsSheet
          action={dialog}
          bots={bots}
          picked={picked}
          targets={targets}
          busy={busy}
          onTargets={setTargets}
          onSubmit={() => run(dialog)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

export function BulkSkills({
  bots,
  skills,
  visibleIds,
  children,
}: {
  bots: Bot[];
  skills: SelectableSkill[];
  visibleIds: string[];
  children: ReactNode;
}) {
  const bulk = useBulkSkills(bots, skills);
  const { selection, picked, busy } = bulk;

  return (
    <SelectionContext value={selection}>
      <BulkReport report={bulk.report} />
      <div
        data-selecting={picked.length > 0 || undefined}
        className="group/skills flex flex-col gap-6"
      >
        <div className="-mb-3 px-3.25">
          <SelectSkills
            ids={visibleIds}
            label="Select all results"
            place="all"
          />
        </div>
        {children}
        {picked.length > 0 && (
          <BulkActionBar
            picked={picked}
            busy={busy}
            hasBots={bots.length > 0}
            onClear={bulk.clear}
            onAction={bulk.start}
          />
        )}
      </div>
      <BulkDialogs bots={bots} bulk={bulk} />
    </SelectionContext>
  );
}
