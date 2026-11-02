import { createContext, type ReactNode, useContext, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { EditorSheet } from "@/components/form-fields";
import { ConfirmDeleteContent } from "@/components/workspace";
import { type Bot } from "@/lib/api";
import { BotPills, toggled } from "./bot-pills";
import { invalidateSkills } from "./skill-cache";
import {
  applyBulkAction,
  skillLabel,
  type BulkAction,
  type SelectableSkill,
} from "./bulk-skill-actions";

type Selection = {
  selected: Set<string>;
  change: (ids: string[], on: boolean) => void;
  busy: boolean;
};

const SelectionContext = createContext<Selection | null>(null);

/** Native checkboxes keep keyboard interaction and mixed section selection accessible. */
export function SelectSkills({ ids, label }: { ids: string[]; label: string }) {
  const selection = useContext(SelectionContext);

  if (!selection || !ids.length) return null;
  const count = ids.filter((id) => selection.selected.has(id)).length;

  return (
    <label className="flex shrink-0 items-center gap-2 text-xs">
      <input
        type="checkbox"
        className="size-4 accent-primary"
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
      {ids.length > 1 || label.startsWith("Select all") ? label : null}
    </label>
  );
}

const ACTIONS: { action: BulkAction; label: string }[] = [
  { action: "delete", label: "Delete" },
  { action: "update", label: "Update" },
  { action: "assign", label: "Assign to bots" },
  { action: "remove", label: "Remove from bots" },
];

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
      className="flex flex-col gap-2 rounded-xl border p-3"
      aria-label="Selected skills"
    >
      <p className="text-sm">{picked.length} selected</p>
      <div className="flex flex-wrap gap-2">
        {ACTIONS.map(({ action, label }) => (
          <Button
            key={action}
            variant={action === "delete" ? "destructive" : "outline"}
            disabled={busy || disabled.has(action)}
            onClick={() => onAction(action)}
          >
            {label}
          </Button>
        ))}
        <Button variant="ghost" disabled={busy} onClick={onClear}>
          Clear selection
        </Button>
      </div>
      {notInstalled.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Update skips skills not installed from GitHub:{" "}
          {notInstalled.map(skillLabel).join(", ")}.
        </p>
      )}
      {busy && <p role="status">Applying action…</p>}
    </div>
  );
}

/** Bulk orchestration uses independent, retry-safe per-skill requests. No successful change is rolled back. */
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
  const [selected, setSelected] = useState(new Set<string>());
  const [dialog, setDialog] = useState<BulkAction | null>(null);
  const [targets, setTargets] = useState(new Set<string>());
  const [report, setReport] = useState<string[]>([]);
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

  const run = (action: BulkAction) => {
    setDialog(null);
    setReport([]);
    bulk.mutate(action);
  };

  return (
    <SelectionContext
      value={{
        selected,
        busy: bulk.isPending,
        change: (ids, on) =>
          setSelected((old) => {
            const next = new Set(old);

            for (const id of ids) {
              if (on) next.add(id);
              else next.delete(id);
            }

            return next;
          }),
      }}
    >
      <div className="flex flex-col gap-3">
        <SelectSkills ids={visibleIds} label="Select all results" />
        {picked.length > 0 && (
          <BulkActionBar
            picked={picked}
            busy={bulk.isPending}
            hasBots={bots.length > 0}
            onClear={() => setSelected(new Set())}
            onAction={(action) => {
              if (action === "update") run(action);
              else {
                setTargets(new Set());
                setDialog(action);
              }
            }}
          />
        )}
        {report.length > 0 && (
          <Alert>
            <AlertDescription>
              <ul aria-label="Bulk action results">
                {report.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </div>
      {children}
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
        <EditorSheet
          title={dialog === "assign" ? "Assign to bots" : "Remove from bots"}
          submitLabel={dialog === "assign" ? "Assign" : "Remove"}
          submitDisabled={!targets.size || bulk.isPending}
          onSubmit={() => run(dialog)}
          onClose={() => setDialog(null)}
        >
          <p className="text-sm">
            {dialog === "assign"
              ? "Shared skills are enabled. Bot-specific skills are copied; existing linked copies and their edits are kept."
              : "Shared skills are disabled. Only linked bot-specific copies are deleted, including edited copies; same-name skills and the original are kept."}
          </p>
          <p className="text-sm">{picked.map(skillLabel).join(", ")}</p>
          <BotPills
            label="Choose bots"
            bots={bots}
            isOn={(bot) => targets.has(bot.id)}
            onToggle={(bot, on) => setTargets(toggled(targets, bot.id, on))}
          />
        </EditorSheet>
      )}
    </SelectionContext>
  );
}
