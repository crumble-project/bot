export const relativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
});

const shortRelativeTime = new Intl.RelativeTimeFormat(undefined, {
  numeric: "auto",
  style: "short",
});

export const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

export function ago(iso: string) {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);

  if (minutes > -60) return shortRelativeTime.format(minutes, "minute");

  if (minutes > -24 * 60)
    return shortRelativeTime.format(Math.round(minutes / 60), "hour");

  return shortRelativeTime.format(Math.round(minutes / (24 * 60)), "day");
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["minute", 60],
  ["hour", 60],
  ["day", 24],
  ["week", 7],
  ["month", 4.35],
  ["year", 12],
];

export function agoInLargestUnit(iso: string, now: number) {
  let value = (Date.parse(iso) - now) / 1000;
  let unit: Intl.RelativeTimeFormatUnit = "second";

  for (const [next, size] of STEPS) {
    if (Math.abs(value) < size) break;

    value /= size;
    unit = next;
  }

  return unit === "second"
    ? relativeTime.format(0, "minute")
    : relativeTime.format(Math.round(value), unit);
}
