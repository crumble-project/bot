import { isAbsolute, relative, sep } from "node:path";

export function emulateDirectoriesOverlap(
  actual: string,
  ordinary: string,
): boolean {
  return [relative(actual, ordinary), relative(ordinary, actual)].some(
    (path) =>
      !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`),
  );
}

export const EMULATE_MODEL_IDS = [
  "local-reply",
  "local-stream",
  "local-tool",
  "local-error",
  "local-stall",
] as const;

export type EmulateModelId = (typeof EMULATE_MODEL_IDS)[number];

export type EmulateProfile = { baseUrl: string };
