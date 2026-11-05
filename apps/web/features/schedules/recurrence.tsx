import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SelectOptions } from "@/components/form-fields";
import { cn } from "@/lib/utils";

/** A cron the schedule picker can show without cron syntax; anything else is custom. */
export type Recurrence =
  | { kind: "hourly"; minute: number }
  | { kind: "daily" | "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; days: number[]; hour: number; minute: number }
  | { kind: "monthly"; day: number; hour: number; minute: number };

export const KINDS = [
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "monthly",
] as const;

const REPEATS = [
  { value: "hourly", label: "Every hour" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Every weekday" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "custom", label: "Custom" },
];

// Monday first; cron counts Sunday as 0.
const WEEK = [1, 2, 3, 4, 5, 6, 0];

const weekdayName = (day: number, weekday: "short" | "long") =>
  // 2023-01-01 was a Sunday, so day n is n days later.
  new Date(2023, 0, 1 + day).toLocaleDateString(undefined, { weekday });

const time = (match: RegExpExecArray) => ({
  minute: Number(match[1]),
  hour: Number(match[2]),
});

// The crons the schedule picker shows in words, by their fields.
const WORDED_CRONS: [RegExp, (match: RegExpExecArray) => Recurrence][] = [
  [
    /^(\d+) \* \* \* \*$/,
    (match) => ({ kind: "hourly", minute: Number(match[1]) }),
  ],
  [/^(\d+) (\d+) \* \* \*$/, (match) => ({ kind: "daily", ...time(match) })],
  [
    /^(\d+) (\d+) \* \* 1-5$/,
    (match) => ({ kind: "weekdays", ...time(match) }),
  ],
  [
    /^(\d+) (\d+) \* \* ([0-7](?:,[0-7])*)$/,
    (match) => ({
      kind: "weekly",
      days: [
        ...new Set((match[3] ?? "").split(",").map((day) => Number(day) % 7)),
      ],
      ...time(match),
    }),
  ],
  [
    /^(\d+) (\d+) (\d+) \* \*$/,
    (match) => ({
      kind: "monthly",
      minute: Number(match[1]),
      hour: Number(match[2]),
      day: Number(match[3]),
    }),
  ],
];

const inBounds = (recurrence: Recurrence) =>
  recurrence.minute <= 59 &&
  (!("hour" in recurrence) || recurrence.hour <= 23) &&
  (recurrence.kind !== "monthly" ||
    (recurrence.day >= 1 && recurrence.day <= 31));

export function recurrenceOf(cron: string): Recurrence | null {
  const text = cron.trim().replace(/\s+/g, " ");

  for (const [pattern, build] of WORDED_CRONS) {
    const match = pattern.exec(text);

    if (match) return inBounds(build(match)) ? build(match) : null;
  }

  return null;
}

export function cronOf(recurrence: Recurrence) {
  if (recurrence.kind === "hourly") return `${recurrence.minute} * * * *`;

  const { minute, hour } = recurrence;

  switch (recurrence.kind) {
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${[...recurrence.days].sort((a, b) => a - b).join(",")}`;
    case "monthly":
      return `${minute} ${hour} ${recurrence.day} * *`;
  }
}

/** Every setting a recurrence can carry, so switching kinds keeps what was chosen. */
type RecurrenceSettings = {
  hour: number;
  minute: number;
  days: number[];
  day: number;
};

/** The recurrence `kind` turns into, keeping what the current one already set. */
export function switchedTo(
  kind: Recurrence["kind"],
  current: Recurrence | null,
): Recurrence {
  const kept: RecurrenceSettings = {
    hour: 9,
    minute: 0,
    days: [1],
    day: 1,
    ...current,
  };

  const { hour, minute } = kept;

  switch (kind) {
    case "hourly":
      return { kind, minute };
    case "weekly":
      return { kind, days: kept.days, hour, minute };
    case "monthly":
      return { kind, day: kept.day, hour, minute };
    default:
      return { kind, hour, minute };
  }
}

const pad = (value: number) => String(value).padStart(2, "0");

export type When = "once" | Recurrence["kind"] | "custom";

export const WHEN = [
  { value: "once", label: "Once" },
  ...REPEATS.map((item) =>
    item.value === "custom" ? { ...item, label: "Custom (cron)" } : item,
  ),
];

const MINUTES = Array.from({ length: 12 }, (_, index) => ({
  value: String(index * 5),
  label: `:${pad(index * 5)}`,
}));

const MONTH_DAYS = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

/** The five-minute grid, plus the current minute when it falls between. */
const minuteItems = (minute: number) =>
  minute % 5
    ? [...MINUTES, { value: String(minute), label: `:${pad(minute)}` }].sort(
        (a, b) => Number(a.value) - Number(b.value),
      )
    : MINUTES;

export function InlineSelect({
  label,
  value,
  items,
  className,
  onChange,
}: {
  label: string;
  value: string;
  items: { value: string; label: string }[];
  className?: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => next && onChange(next)}
    >
      <SelectTrigger aria-label={label} className={cn("w-auto", className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectOptions items={items} />
    </Select>
  );
}

const Word = ({ children }: { children: ReactNode }) => (
  <span className="text-sm text-muted-foreground">{children}</span>
);

function TimeInput({
  recurrence,
  onChange,
}: {
  recurrence: Exclude<Recurrence, { kind: "hourly" }>;
  onChange: (next: Recurrence) => void;
}) {
  return (
    <Input
      type="time"
      aria-label="Time"
      required
      className="w-auto"
      value={`${pad(recurrence.hour)}:${pad(recurrence.minute)}`}
      onChange={(event) => {
        const [hour, minute] = event.target.value.split(":").map(Number);

        if (hour === undefined || minute === undefined) return;

        onChange({ ...recurrence, hour, minute });
      }}
    />
  );
}

function WeekdayToggles({
  days,
  onChange,
}: {
  days: number[];
  onChange: (days: number[]) => void;
}) {
  return (
    <div
      className="grid w-full grid-cols-7 gap-1"
      role="group"
      aria-label="Days"
    >
      {WEEK.map((day) => {
        const on = days.includes(day);

        return (
          <Button
            key={day}
            type="button"
            size="sm"
            variant={on ? "default" : "outline"}
            aria-pressed={on}
            title={weekdayName(day, "long")}
            // A week needs at least one day.
            disabled={on && days.length === 1}
            onClick={() =>
              onChange(
                on ? days.filter((each) => each !== day) : [...days, day],
              )
            }
          >
            {weekdayName(day, "short")}
          </Button>
        );
      })}
    </div>
  );
}

/** The rest of the sentence after the When choice, laid out inline. */
export function RecurrenceParts({
  recurrence,
  onChange,
}: {
  recurrence: Recurrence;
  onChange: (next: Recurrence) => void;
}) {
  if (recurrence.kind === "hourly")
    return (
      <>
        <Word>at</Word>
        <InlineSelect
          label="Minute"
          value={String(recurrence.minute)}
          items={minuteItems(recurrence.minute)}
          onChange={(minute) =>
            onChange({ ...recurrence, minute: Number(minute) })
          }
        />
      </>
    );

  return (
    <>
      {recurrence.kind === "weekly" && (
        <>
          <Word>on</Word>
          <WeekdayToggles
            days={recurrence.days}
            onChange={(days) => onChange({ ...recurrence, days })}
          />
        </>
      )}
      {recurrence.kind === "monthly" && (
        <>
          <Word>on day</Word>
          <InlineSelect
            label="Day of the month"
            value={String(recurrence.day)}
            items={MONTH_DAYS}
            onChange={(day) => onChange({ ...recurrence, day: Number(day) })}
          />
        </>
      )}
      <Word>at</Word>
      <TimeInput recurrence={recurrence} onChange={onChange} />
    </>
  );
}
