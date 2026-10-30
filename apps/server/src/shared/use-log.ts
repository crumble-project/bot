import { and, eq, lt } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

/** A log of one agent's uses of its named secrets, paged newest first by id. */
type UseLog = { id: SQLiteColumn; agentId: SQLiteColumn; name: SQLiteColumn };

/** The uses of one secret older than `before`, the id of a use on an earlier page; any other `before` starts at the newest. */
export const usesBefore = (
  log: UseLog,
  agentId: string,
  name: string,
  before: string | undefined,
) => {
  const cursor = Number(before);

  return and(
    eq(log.agentId, agentId),
    eq(log.name, name),
    lt(
      log.id,
      Number.isSafeInteger(cursor) && cursor > 0
        ? cursor
        : Number.MAX_SAFE_INTEGER,
    ),
  );
};

/** Use rows with their numeric ids as the strings the API pages by. */
export const withStringIds = <Row extends { id: number }>(rows: Row[]) =>
  rows.map((row) => ({ ...row, id: String(row.id) }));
