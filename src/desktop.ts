import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type ConversationId,
  type EnvTarget,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { computerUseTool } from "./computer-use";
import type { DesktopControl } from "./desktop-control";
import type { Agent } from "./domain";
import { defineJobKind, type JobExtensions } from "./jobs";
import type { CrumblePlugin } from "./plugins";
import type { Workspaces } from "./workspace";

export const DESKTOP_TOOL_NAME = "desktop";

const desktop = defineJobKind({
  kind: "desktop",
  toolName: DESKTOP_TOOL_NAME,
  label: "desktop job",
  exclusive: true,
  description:
    "Run desktop jobs: background agents that operate your bot desktop, a Linux desktop with Chromium and other apps in your workspace, with mouse and keyboard. " +
    "Use them for websites and apps that need a browser or a screen: pages without an API, forms, logged-in accounts. Browser logins and files persist between jobs. " +
    "Actions: start (name, message: the full task, since the job knows nothing else), send (name, message; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
    "One desktop job works at a time; others wait. Starting a job or sending it a message ends your turn, and the owner sees the job as a card, so write anything else the owner needs before the call and do not describe the job. " +
    "A job asks when it needs the owner, such as for a login or a payment; pass the owner's answer on with send. To check or continue a job's work, send to that job: a new job starts from nothing and does everything again. Ask the owner before retrying anything that submits, buys, or sends. Jobs keep working after your turn ends; their final answer arrives later as a message from the job. Do not wait or poll for it.",
  instructions: [
    "You are a desktop job for another bot. You operate a Linux desktop: Openbox, Chromium maximized, a panel at the bottom. Use the computer_use tool.",
    "Start with action='capture'. Prefer element indices and set_value over coordinates; use mode='vision' only when the tree lacks what you need.",
    "To open a URL in Chromium: key 'ctrl+l' (selects the address bar), type the URL, key 'return'. Typing into a field appends to its text; use set_value to replace it.",
    "Use capture_after=true on actions whose effect you need to check. Omit parameters you don't use.",
    "When an action's effect is unverifiable, look at the screen before you rely on it; check that boxes and choices are set before you submit a form.",
    "If something is the owner's to do or decide (a login, a captcha, a payment, a choice the task didn't settle), stop and say exactly what you need instead of guessing.",
    "Finish with a short report: what you did, what you saw, and what is left.",
  ].join(" "),
});

/** The job a successful `desktop` result shows as a card; a listing or a failed call shows none. */
export const desktopJobOf = desktop.jobOf;

/** Hears the bot's answer to each desktop job report, for notifications. */
export const desktopAnswers = desktop.onAnswer;

export const desktopJobs = (harness: Harness, chatId: ConversationId) =>
  desktop.list(harness, chatId);

export const desktopEnv = (
  workspaces: Workspaces,
  agentId: string,
  target: EnvTarget,
  context: Context,
): Promise<ExecutionEnv | undefined> =>
  desktop.env(workspaces, agentId, target, context);

type ComputerUseTool = ReturnType<typeof computerUseTool>;

const UNCONTROLLED = {};

// One tool per bot and lease: the runtime rebuilds a bot's extensions whenever it reconfigures the bot, and a running
// job must keep its snapshots and the lease change count it last saw.
const tools = new WeakMap<object, Map<string, ComputerUseTool>>();

function toolFor(agentId: string, control: DesktopControl | undefined) {
  const scope = control ?? UNCONTROLLED;
  const byAgent = tools.get(scope) ?? new Map<string, ComputerUseTool>();
  let tool = byAgent.get(agentId);

  if (!tool) {
    // While the owner has control, every computer_use call waits for hand-back.
    tool = computerUseTool(
      control &&
        (() => ({
          untilBot: (context) => control.untilBot(agentId, context),
        })),
    );
    byAgent.set(agentId, tool);
    tools.set(scope, byAgent);
  }

  return tool;
}

/** Lets a bot run desktop jobs: child conversations with the computer_use tool on its bot desktop. */
export function desktopExtensions(
  agent: Pick<Agent, "id" | "desktopModel">,
  control?: DesktopControl,
): JobExtensions {
  const job = defineExtension({
    name: "desktop-job",
    tools: [toolFor(agent.id, control)],
  });

  return desktop.extensions({
    agentId: agent.id,
    job,
    ...(agent.desktopModel && {
      model: {
        provider: agent.desktopModel.provider,
        modelId: agent.desktopModel.model,
      },
    }),
  });
}

/** Desktop jobs as a plugin: offered to bots with the `desktop` tool while workspaces have bot desktops. */
export const desktopPlugin = (
  workspaces: Workspaces | undefined,
  control: DesktopControl,
): CrumblePlugin => ({
  id: "desktop",
  jobKinds: workspaces?.desktop
    ? [
        {
          kind: "desktop",
          enabled: (agent) => agent.tools.includes(DESKTOP_TOOL_NAME),
          extensions: (agent) => desktopExtensions(agent, control),
          env: (agentId, target, context) =>
            desktopEnv(workspaces, agentId, target, context),
          onAnswer: desktopAnswers,
        },
      ]
    : [],
});
