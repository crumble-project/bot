import { DateTime, Effect } from "effect";

/** The current time as an ISO string, from Effect's Clock so tests can control it. */
export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
