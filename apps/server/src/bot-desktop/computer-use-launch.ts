import { sleep } from "../shared/time";
import { shellQuote } from "../shared/shell";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import {
  FILES_PROGRAM,
  TERMINAL_PROGRAM,
  WORKSPACE_PATH,
} from "../../workspace-image/guest";
import type { ComputerUseArgs } from "./computer-use-args";
import type { ComputerUseResult } from "./computer-use";
import { driverCall, listWindows, sh } from "./computer-use-driver";
import { textResult, type ComputerUseState } from "./computer-use-state";

/** Apps whose command takes the folder in its own way; any other app gets the path as its last argument. */
const FOLDER_APPS = {
  files: (path: string) => `${FILES_PROGRAM} ${shellQuote(path)}`,
  terminal: (path: string) =>
    `${TERMINAL_PROGRAM} --working-directory=${shellQuote(path)}`,
} satisfies Record<string, (path: string) => string>;

const isFolderApp = (name: string): name is keyof typeof FOLDER_APPS =>
  Object.hasOwn(FOLDER_APPS, name);

const installedApps = z.object({
  apps: z
    .array(
      z.object({
        name: z.string(),
        kind: z.string().nullish(),
        launch_path: z.string().nullish(),
        running: z.boolean().nullish(),
      }),
    )
    .default([]),
});

/** The desktop's installed apps: XDG launcher entries, as `cua-driver` lists them. */
async function desktopApps(state: ComputerUseState, context: Context) {
  const { reply } = await driverCall(state, "list_apps", {}, context);

  return installedApps
    .parse(reply)
    .apps.filter((app) => app.kind === "desktop" && app.launch_path);
}

export async function listApps(state: ComputerUseState, context: Context) {
  // cua-driver lists a running app once per process.
  const running = new Map<string, boolean>();

  for (const app of await desktopApps(state, context))
    running.set(app.name, (running.get(app.name) ?? false) || !!app.running);

  if (!running.size) return textResult("no installed apps found");

  return textResult(
    [...running]
      .map(([name, on]) => `${name}${on ? " (running)" : ""}`)
      .join("\n"),
  );
}

async function commandFor(
  state: ComputerUseState,
  app: string,
  path: string | undefined,
  context: Context,
) {
  const key = app.toLowerCase();

  if (isFolderApp(key)) return FOLDER_APPS[key](path ?? WORKSPACE_PATH);

  const entry = (await desktopApps(state, context)).find(
    (each) => each.name.toLowerCase() === key,
  );

  if (!entry?.launch_path) return undefined;

  return path ? `${entry.launch_path} ${shellQuote(path)}` : entry.launch_path;
}

const WINDOW_WAIT_MS = 8000;

const POLL_MS = 250;

/**
 * Starts an installed app, optionally on a folder or file, and reports its window. The panel's launchers sit outside
 * any window a job can target, so this is how a job starts an app.
 */
export async function launchApp(
  state: ComputerUseState,
  args: ComputerUseArgs,
  context: Context,
): Promise<ComputerUseResult> {
  if (!args.app)
    return textResult(
      "launch needs app: Files, Terminal, or a name from list_apps",
      true,
    );

  if (args.path !== undefined && !args.path.startsWith("/"))
    return textResult("launch: path must be absolute", true);

  const command = await commandFor(state, args.app, args.path, context);

  if (!command)
    return textResult(
      `no installed app named "${args.app}"; call list_apps for the names`,
      true,
    );

  const before = new Set(
    (await listWindows(state, context)).map((each) => each.window_id),
  );

  // setsid and closed streams let the app outlive this command.
  await sh(
    state.shell,
    `setsid ${command} >/dev/null 2>&1 </dev/null &`,
    context,
  );

  for (let waited = 0; waited < WINDOW_WAIT_MS; waited += POLL_MS) {
    const opened = (await listWindows(state, context)).find(
      (each) => !before.has(each.window_id),
    );

    if (opened)
      return textResult(
        `opened ${args.app}${args.path ? ` at ${args.path}` : ""}: window ${opened.window_id} ${opened.app_name} "${opened.title}". Capture it to act in it.`,
      );

    await sleep(POLL_MS);
  }

  return textResult(
    `started ${args.app}, but no new window appeared within ${WINDOW_WAIT_MS / 1000}s; it may have reused an open window. Call list_windows.`,
    true,
  );
}
