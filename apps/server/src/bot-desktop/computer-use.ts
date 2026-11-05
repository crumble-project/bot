// Ported from Hermes Agent's computer_use tool (tools/computer_use/schema.py, MIT, Nous Research). Changes, measured in
// the bot desktop spike: captures default to the accessibility tree with diff reads instead of screenshots, input
// climbs from background to foreground on its own (the bot owns its display), and only actions an intent check holds
// wait for approval.
import type { Context } from "@earendil-works/chord";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { ControlState } from "./desktop-control";
import type { DesktopFills, LoginFill } from "./computer-use-login";
import {
  computerUseState,
  type ComputerUseOptions,
} from "./computer-use-state";
import {
  computerUseParameters,
  type ComputerUseArgs,
} from "./computer-use-args";
import { runAction } from "./computer-use-run";
import type { IntentGate } from "./computer-use-intent";
import { COMPUTER_USE_TOOL_NAME } from "../contract/tools";

/** The part of a job's environment the tool needs. */
export type DesktopShell = Pick<
  ExecutionEnv,
  "exec" | "writeFile" | "readBinaryFile"
>;

export type ComputerUseResult = {
  content: (TextContent | ImageContent)[];
  isError: boolean;
  /** Model calls the tool made itself, such as an intent check's judge. */
  usage?: Usage;
};

/** The bot's turn on its desktop: resolves once the bot holds control. */
export type ControlGate = {
  untilBot(context: Context): Promise<ControlState>;
};

export function createComputerUse(
  shell: DesktopShell,
  options: ComputerUseOptions = {},
) {
  const state = computerUseState(shell, options);

  return {
    run: (raw: ComputerUseArgs, context: Context, intent?: IntentGate) =>
      runAction(state, raw, context, intent),
  };
}

/** The tool for a desktop job, over the job's environment. One instance per job conversation keeps its snapshots. */
export function computerUseTool({
  gateFor,
  logins,
  fills,
  intentFor,
}: {
  gateFor?: ((conversationId: string) => ControlGate) | undefined;
  logins?: LoginFill | undefined;
  fills?: DesktopFills | undefined;
  /** The intent check of one call, which reads the job's request and posts a held action's card. */
  intentFor?: ((api: ToolExecutionApi) => IntentGate) | undefined;
} = {}) {
  const instances = new Map<string, ReturnType<typeof createComputerUse>>();

  return defineTool({
    name: COMPUTER_USE_TOOL_NAME,
    description:
      "Operate the bot desktop (XFCE with Chromium, the Thunar file manager, a terminal, other X11 apps) through its accessibility tree, mouse, and keyboard. " +
      "Workflow: action='capture' returns the focused window's accessibility tree; every actionable element is tagged [N]. " +
      "Act on elements by index (element=N), which is more reliable than coordinates. Later captures of the same window list only what changed " +
      "(+ added, ~ changed, - removed) and keep earlier [N] unless a 'reindexed' line says otherwise. Use mode='vision' for a screenshot when the " +
      "tree is missing something; coordinates are pixels of that screenshot. Narrow a large capture with query. " +
      "Web pages in Chromium: action='open' loads a URL and action='read' returns the page with its elements tagged [pN:M]; act on them with ref " +
      "instead of element. Refs last until the page navigates or is read again. " +
      "When you know several steps ahead, action='steps' runs them in one call, naming each element by role and name, with expect checks. " +
      "Each result carries a verdict: never repeat confirmed input; capture or read to check an unverified one before retrying.",
    parameters: computerUseParameters,
    callers: ["model"],
    // Input already sent cannot be taken back; after a crash the job captures and decides.
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const env = api.env;

      if (!env)
        return {
          output: [
            {
              type: "text" as const,
              text: "No bot desktop is available here.",
            },
          ],
          isError: true,
        };

      const key = String(api.conversationId);
      let computer = instances.get(key);

      if (!computer) {
        computer = createComputerUse(env, {
          gate: gateFor?.(key),
          logins,
          fills,
        });
        instances.set(key, computer);
      }

      const result = await computer.run(args, callContext, intentFor?.(api));

      return {
        output: result.content,
        isError: result.isError,
        ...(result.usage && { usage: result.usage }),
      };
    },
  });
}
