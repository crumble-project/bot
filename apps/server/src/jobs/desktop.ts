import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  type ConversationId,
  type EnvTarget,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { computerUseTool } from "../bot-desktop/computer-use";
import type { DesktopFills } from "../bot-desktop/computer-use-login";
import type { DesktopControlAccess } from "../bot-desktop/desktop-control";
import {
  desktopIntentGate,
  gateCallOf,
  type DesktopIntent,
} from "./desktop-intent";
import type { Agent } from "../shared/domain";
import {
  jobLoginSection,
  loginExtension,
  loginFill,
  type LoginsAccess,
} from "../logins/logins";
import { defineJobKind, type JobExtensions } from "./jobs";
import type { CrumblePlugin } from "../plugins/plugins";
import type { Workspaces } from "../workspaces/workspace";

export const DESKTOP_TOOL_NAME = "desktop";

const desktop = defineJobKind({
  kind: "desktop",
  toolName: DESKTOP_TOOL_NAME,
  label: "desktop job",
  exclusive: true,
  ownerRequest: true,
  description:
    "Run desktop jobs: background agents that operate your bot desktop, a Linux desktop with Chromium and other apps in your workspace, with mouse and keyboard. " +
    "Use them for websites and apps that need a browser or a screen: pages without an API, forms, logged-in accounts. Browser logins and files persist between jobs. " +
    "Actions: start (name, message: the full task, since the job knows nothing else; owner_messages: the request IDs of the owner's messages the task comes from), send (name, message, owner_messages; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
    "One desktop job works at a time; others wait. Starting a job or sending it a message ends your turn, and the owner sees the job as a card, so write anything else the owner needs before the call and do not describe the job. " +
    "A job asks when it needs the owner, such as for a login or a payment; pass the owner's answer on with send. To check or continue a job's work, send to that job: a new job starts from nothing and does everything again. Ask the owner before retrying anything that submits, buys, or sends. Jobs keep working after your turn ends; their final answer arrives later as a message from the job. Do not wait or poll for it. " +
    "Desktop jobs share your workspace with coding jobs, localhost included: to test a web app a coding job serves, give the desktop job its URL and what to check, and send what fails to that coding job. If the app does not load, have a coding job start its server again.",
  instructions: [
    "You are a desktop job for another bot. You operate a Linux desktop: Openbox, Chromium maximized, a panel at the bottom. Use the computer_use tool.",
    "For web pages, use open with the URL and read (with query on long pages), then act with ref from the latest read. Use capture and element for Chromium's own menus and dialogs and for other apps; prefer element indices and set_value over coordinates, and mode='vision' only when the tree lacks what you need.",
    "When you know several steps in an app, run them in one steps call with expect checks instead of one call each. Typing into a field appends to its text; use set_value to replace it.",
    "Apps the bot's coding jobs serve open at their localhost URL. If such a page does not load, report that its server is not running instead of testing further.",
    "Use capture_after=true on actions whose effect you need to check. Omit parameters you don't use.",
    "When an action's effect is unverifiable, look at the screen before you rely on it; check that boxes and choices are set before you submit a form.",
    "If something is the owner's to do or decide (a login, a captcha, a payment, a choice the task didn't settle), stop and say exactly what you need instead of guessing.",
    "An action that submits, sends, buys, or deletes may wait for the owner's approval. If one returns REFUSED, don't retry it or work around it; report back.",
    "Finish with a short report: what you did, what you saw, and what is left. When testing, list each check as passed or failed with what you saw, quoting error messages exactly.",
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

/** What desktop jobs fill logins from, and where each bot desktop records the values typed on it. */
export type DesktopLogins = {
  access: LoginsAccess;
  fills: (agentId: string) => DesktopFills;
};

const UNCONTROLLED = {};

// One tool per bot and lease: the runtime rebuilds a bot's extensions whenever it reconfigures the bot, and a running
// job must keep its snapshots and the lease change count it last saw.
const tools = new WeakMap<object, Map<string, ComputerUseTool>>();

function toolFor(
  agentId: string,
  control: DesktopControlAccess | undefined,
  logins: DesktopLogins | undefined,
  intent: DesktopIntent | undefined,
) {
  const scope = control ?? UNCONTROLLED;
  const byAgent = tools.get(scope) ?? new Map<string, ComputerUseTool>();
  let tool = byAgent.get(agentId);

  if (!tool) {
    // While the owner has control, every computer_use call waits for hand-back.
    tool = computerUseTool({
      gateFor:
        control &&
        (() => ({
          untilBot: (context) => control.untilBot(agentId, context),
        })),
      logins: logins && loginFill(logins.access, agentId),
      fills: logins?.fills(agentId),
      intentFor:
        intent &&
        ((api) =>
          desktopIntentGate(intent, agentId, gateCallOf(api, desktop.request))),
    });
    byAgent.set(agentId, tool);
    tools.set(scope, byAgent);
  }

  return tool;
}

/** Lets a bot run desktop jobs: child conversations with the computer_use tool on its bot desktop. */
export function desktopExtensions(
  agent: Pick<Agent, "id" | "desktopModel">,
  control?: DesktopControlAccess,
  logins?: DesktopLogins,
  intent?: DesktopIntent,
): JobExtensions {
  const job = defineExtension({
    name: "desktop-job",
    tools: [toolFor(agent.id, control, logins, intent)],
    sections: logins
      ? [
          {
            key: "desktop_logins",
            // Installed job extensions render in the bot's chat too; only a job needs this.
            render: async (input, context) =>
              (await desktop.isJob(input.read, input.conversationId, context))
                ? jobLoginSection(logins.access.list(agent.id))
                : undefined,
          },
        ]
      : [],
  });

  const extensions = desktop.extensions({
    agentId: agent.id,
    job,
    ...(agent.desktopModel && {
      model: {
        provider: agent.desktopModel.provider,
        modelId: agent.desktopModel.model,
      },
    }),
  });

  return logins
    ? {
        ...extensions,
        chat: [...extensions.chat, loginExtension(agent.id, logins.access)],
      }
    : extensions;
}

/** Desktop jobs as a plugin: offered to bots with the `desktop` tool while workspaces have bot desktops. */
export const desktopPlugin = (
  workspaces: Workspaces | undefined,
  control: DesktopControlAccess,
  logins?: DesktopLogins,
  intent?: DesktopIntent,
): CrumblePlugin => ({
  id: "desktop",
  jobKinds: workspaces?.desktop
    ? [
        {
          kind: "desktop",
          enabled: (agent) => agent.tools.includes(DESKTOP_TOOL_NAME),
          extensions: (agent) =>
            desktopExtensions(agent, control, logins, intent),
          env: (agentId, target, context) =>
            desktopEnv(workspaces, agentId, target, context),
          onAnswer: desktopAnswers,
        },
      ]
    : [],
});
