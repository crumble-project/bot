import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { type Change, queryClient, send } from "@/lib/api";

type State = Change["before"];

const VERBS: Record<Change["action"], string> = {
  create: "added",
  update: "changed",
  delete: "deleted",
  revert: "reverted",
};

function actorLabel(change: Change, botName: string | null) {
  switch (change.actor) {
    case "owner":
      return "You";
    case "bot":
      return botName ?? "A bot";
    case "review":
      return botName ? `${botName}'s review` : "A review";
    case "curator":
      return "The curator";
  }
}

/** What happened, such as "Kev's review changed a skill". */
export function changeSummary(change: Change, botName: string | null) {
  const target =
    change.target === "skill"
      ? "a skill"
      : change.agentId
        ? "a memory"
        : "a shared memory";

  return `${actorLabel(change, botName)} ${VERBS[change.action]} ${target}`;
}

/** The skill's name or the memory's first line. */
export function changeTitle(change: Change) {
  const state = change.after ?? change.before;

  if (!state) return change.targetId;

  if ("content" in state) return state.content.split("\n")[0] ?? "";

  return state.name;
}

/** The state as plain lines, so a skill's name, description, instructions, and documents diff together. */
function lines(state: State) {
  if (!state) return [];

  if ("content" in state) return state.content.split("\n");

  return [
    `# ${state.name}`,
    state.description,
    "",
    ...state.instructions.split("\n"),
    ...state.documents.flatMap((document) => [
      "",
      `--- ${document.path}`,
      ...document.content.split("\n"),
    ]),
  ];
}

type DiffLine = { kind: " " | "-" | "+"; text: string };

function commonHead(before: string[], after: string[]) {
  let head = 0;

  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  )
    head++;

  return head;
}

function commonTail(before: string[], after: string[], head: number) {
  let tail = 0;

  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail++;

  return tail;
}

function commonLengths(a: string[], b: string[]) {
  const table = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );

  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      table[i]![j] =
        a[i] === b[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);

  return table;
}

function walkDiff(a: string[], b: string[]) {
  const table = commonLengths(a, b);
  const middle: DiffLine[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      middle.push({ kind: " ", text: a[i++]! });
      j++;
    } else if (
      i < a.length &&
      (j === b.length || table[i + 1]![j]! >= table[i]![j + 1]!)
    )
      middle.push({ kind: "-", text: a[i++]! });
    else middle.push({ kind: "+", text: b[j++]! });
  }

  return middle;
}

/** A line diff by longest common subsequence, after trimming the shared head and tail. */
function diff(before: string[], after: string[]): DiffLine[] {
  const head = commonHead(before, after);
  const tail = commonTail(before, after, head);

  const middle = walkDiff(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
  );

  const same = (text: string): DiffLine => ({ kind: " ", text });

  return [
    ...before.slice(0, head).map(same),
    ...middle,
    ...before.slice(before.length - tail).map(same),
  ];
}

const LINE_STYLE: Record<DiffLine["kind"], string> = {
  " ": "text-muted-foreground",
  "-": "bg-destructive/10 text-destructive",
  "+": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
};

export function ChangeDiff({ change }: { change: Change }) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted py-3 font-mono text-xs">
      {diff(lines(change.before), lines(change.after)).map((line, index) => (
        <div
          key={index}
          className={cn("px-3 whitespace-pre-wrap", LINE_STYLE[line.kind])}
        >
          {line.kind} {line.text}
        </div>
      ))}
    </pre>
  );
}

/** Reverts a change after confirming; the server records the revert as a change of its own. */
export function RevertChange({ change }: { change: Change }) {
  const target = change.target === "skill" ? "skill" : "memory";

  const revert = useMutation({
    mutationFn: () =>
      send(`/v1/changes/${encodeURIComponent(change.id)}/revert`, "POST"),
    onSettled: () =>
      Promise.all(
        ["activity", "memories", "skills"].map((key) =>
          queryClient.invalidateQueries({ queryKey: [key] }),
        ),
      ),
  });

  return (
    <>
      <AlertDialog>
        <AlertDialogTrigger
          render={
            <Button variant="ghost" size="sm" disabled={revert.isPending}>
              Revert
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert this change?</AlertDialogTitle>
            <AlertDialogDescription>
              {change.before
                ? `The ${target} goes back to how it was before this change. Anything changed since is replaced. The revert is recorded, so you can undo it too.`
                : `The ${target} is deleted again. The revert is recorded, so you can undo it too.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => revert.mutate()}>
              Revert
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {revert.isError && (
        <Alert variant="destructive" className="basis-full">
          <AlertDescription>{revert.error.message}</AlertDescription>
        </Alert>
      )}
    </>
  );
}
