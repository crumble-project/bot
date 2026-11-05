import { cn } from "@/lib/utils";

type Diffable =
  | { content: string }
  | {
      name: string;
      description: string;
      instructions: string;
      documents: { path: string; content: string }[];
    }
  | null;

function lines(state: Diffable) {
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

export function StateDiff({
  before,
  after,
}: {
  before: Diffable;
  after: Diffable;
}) {
  return (
    <pre className="overflow-x-auto rounded-md bg-muted py-3 font-mono text-xs">
      {diff(lines(before), lines(after)).map((line, index) => (
        <div
          // A diff is computed once per change and never reorders.
          // react-doctor-disable-next-line no-array-index-as-key
          key={index}
          className={cn("px-3 whitespace-pre-wrap", LINE_STYLE[line.kind])}
        >
          {line.kind} {line.text}
        </div>
      ))}
    </pre>
  );
}
