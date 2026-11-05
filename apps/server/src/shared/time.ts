import { DateTime, Effect } from "effect";

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
