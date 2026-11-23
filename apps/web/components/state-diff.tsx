import { cn } from "@/lib/utils";

type Diffable =
  | { content: string }
  | {
      name: string;
      description: string;
      instructions: string;
      documents: Array<{ path: string; content: string }>;
    }
  | null;

function lines(state: Diffable) {
  if (!state) {
    return [];
  }

  if ("content" in state) {
    return state.content.split("\n");
  }

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

function commonHead(before: Array<string>, after: Array<string>) {
  let head = 0;

  while (
    head < before.length &&
    head < after.length &&
    before[head] === after[head]
  ) {
    head++;
  }

  return head;
}

function commonTail(before: Array<string>, after: Array<string>, head: number) {
  let tail = 0;

  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  return tail;
}

function commonLengths(a: Array<string>, b: Array<string>) {
  const table: Array<Array<number>> = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );

  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = table[i];

      if (!row) {
        continue;
      }

      row[j] =
        a[i] === b[j]
          ? lengthAt(table, i + 1, j + 1) + 1
          : Math.max(lengthAt(table, i + 1, j), lengthAt(table, i, j + 1));
    }
  }

  return table;
}

function lengthAt(table: Array<Array<number>>, row: number, column: number) {
  return table[row]?.[column] ?? 0;
}

function walkDiff(a: Array<string>, b: Array<string>) {
  const table = commonLengths(a, b);
  const middle: Array<DiffLine> = [];
  let i = 0;
  let j = 0;

  while (i < a.length || j < b.length) {
    const left = i < a.length ? a[i] : undefined;
    const right = j < b.length ? b[j] : undefined;

    if (left !== undefined && right !== undefined && left === right) {
      middle.push({ kind: " ", text: left });
      i++;
      j++;
    } else if (
      left !== undefined &&
      (right === undefined ||
        lengthAt(table, i + 1, j) >= lengthAt(table, i, j + 1))
    ) {
      middle.push({ kind: "-", text: left });
      i++;
    } else if (right !== undefined) {
      middle.push({ kind: "+", text: right });
      j++;
    }
  }

  return middle;
}

function same(text: string): DiffLine {
  return { kind: " ", text };
}

function diff(before: Array<string>, after: Array<string>): Array<DiffLine> {
  const head = commonHead(before, after);
  const tail = commonTail(before, after, head);

  const middle = walkDiff(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
  );

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
          key={index}
          className={cn("px-3 whitespace-pre-wrap", LINE_STYLE[line.kind])}
        >
          {line.kind} {line.text}
        </div>
      ))}
    </pre>
  );
}
