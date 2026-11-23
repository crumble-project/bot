import { CronExpressionParser } from "cron-parser";

export const nextOccurrence = (cron: string, timezone: string, from: Date) =>
  CronExpressionParser.parse(cron, { currentDate: from, tz: timezone })
    .next()
    .toDate();

export const validTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();

    return true;
  } catch {
    return false;
  }
};

export const hasBareWeekdayStep = (cron: string) => {
  const fields = cron.trim().split(/\s+/);

  const weekday =
    fields.length === 5 || fields.length === 6 ? fields.at(-1) : undefined;

  return weekday?.split(",").some((part) => /^[^*-]+\//.test(part)) === true;
};
