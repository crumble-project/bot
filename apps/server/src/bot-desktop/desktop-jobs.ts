import {
  defineExtension,
  type PromptSection,
} from "@earendil-works/pi-durable";
import { computerUseTool } from "./computer-use";
import type { DesktopFills } from "./computer-use-login";
import type { DesktopControlAccess } from "./desktop-control";
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
import {
  defineJobKind,
  modelRef,
  type JobExtensions,
  type JobKind,
} from "../jobs/jobs";
import { JOB_KINDS } from "../jobs/job-kinds";
import type { CrumblePlugin } from "../plugins/plugins";
import type { Workspaces } from "../workspaces/workspace";
import { workspaceNotesSection } from "../jobs/workspace-notes";
import { usesDesktop } from "./desktop-vocabulary";

const DESKTOP_JOBS = {
  description:
    "Run desktop jobs: background agents that operate your bot desktop, a Linux desktop with Chromium and other apps in your workspace, with mouse and keyboard. " +
    "Use them for anything that needs a screen: websites without an API, forms, logged-in accounts, and desktop apps such as the file manager or an app installed in the workspace. Browser logins and files persist between jobs. " +
    "Actions: start (name, message: the task and what only you know about it; the job already sees your standing instructions, memory, skills, and the latest messages of this chat; owner_messages: the request IDs of the owner's messages the task comes from), send (name, message, owner_messages; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
    "One desktop job works at a time; others wait. Starting a job or sending it a message ends your turn, and the owner sees the job as a card, so write anything else the owner needs before the call and do not describe the job. " +
    "A job asks when it needs the owner, such as for a login or a payment; pass the owner's answer on with send. To check or continue a job's work, send to that job: a new job starts from nothing and does everything again. Ask the owner before retrying anything that submits, buys, or sends. Jobs keep working after your turn ends; their final answer arrives later as a message from the job. Do not wait or poll for it. " +
    "Desktop jobs share your workspace, localhost included: to test a web app you or a coding job serve, give the desktop job its URL and what to check. If the app does not load, start its server again yourself or have the coding job that owns it do so.",
  instructions: [
    "You are a desktop job for another bot. You operate a Linux XFCE desktop with Chromium, Files (Thunar), a terminal, and any other installed app; windows open maximized. Start an app with launch (app Files or Terminal with a path, or a name from list_apps) instead of clicking the panel, and switch with list_windows and focus_window. Files live in /workspace; Chromium downloads to /workspace/Downloads. Use the computer_use tool.",
    "To see a terminal's output, read it with the terminal's window_id. In other apps and in Chromium's own menus and dialogs, capture the window and act on element indices; prefer them and set_value over coordinates, and use mode='vision' only when the tree lacks what you need. For web pages, use open with the URL and read (with query on long pages), then act with ref from the latest read.",
    "When you know several steps in an app, run them in one steps call with expect checks instead of one call each. Typing into a field appends to its text; use set_value to replace it.",
    "Load a URL with open, not by typing it into the address bar.",
    "Apps the bot or its coding jobs serve open at their localhost URL. If such a page does not load, report that its server is not running instead of testing further.",
    "Use capture_after=true on actions whose effect you need to check. Omit parameters you don't use.",
    "When an action's effect is unverifiable, look at the screen before you rely on it; check that boxes and choices are set before you submit a form.",
    "If something is the owner's to do or decide (a login, a captcha, a payment, a choice the task didn't settle), stop and say exactly what you need instead of guessing.",
    "An action that submits, sends, buys, or deletes may wait for the owner's approval. If one returns REFUSED, don't retry it or work around it; report back.",
    "You can't send images: when the owner wants to see something, leave it on screen and say so in your report, and the bot shows the owner a screenshot.",
    "Finish with a short report: what you did, what you saw, and what is left. When testing, list each check as passed or failed with what you saw, quoting error messages exactly.",
  ].join(" "),
};

type ComputerUseTool = ReturnType<typeof computerUseTool>;

/** What desktop jobs fill logins from, and where each bot desktop records the values typed on it. */
export type DesktopLogins = {
  access: LoginsAccess;
  fills: (agentId: string) => DesktopFills;
};

type DesktopJobs = {
  desktop: JobKind;
  // One tool per bot: the runtime rebuilds a bot's extensions whenever it reconfigures the bot, and a running job must
  // keep its snapshots and the lease change count it last saw.
  tools: Map<string, ComputerUseTool>;
  control: DesktopControlAccess | undefined;
  logins: DesktopLogins | undefined;
  intent: DesktopIntent | undefined;
};

function toolFor(jobs: DesktopJobs, agentId: string) {
  const { desktop, control, logins, intent } = jobs;
  let tool = jobs.tools.get(agentId);

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
    jobs.tools.set(agentId, tool);
  }

  return tool;
}

/** Lets a bot run desktop jobs: child conversations with the computer_use tool on its bot desktop. */
function desktopExtensions(
  jobs: DesktopJobs,
  agent: Pick<Agent, "id" | "desktopModel">,
): JobExtensions {
  const { desktop, logins } = jobs;

  const job = defineExtension({
    name: JOB_KINDS.desktop.extension,
    tools: [toolFor(jobs, agent.id)],
    sections: [
      workspaceNotesSection(desktop.isJob, false),
      ...(logins
        ? [
            {
              key: "desktop_logins",
              // Installed job extensions render in the bot's chat too; only a job needs this.
              render: async (input, context) =>
                (await desktop.isJob(input.read, input.conversationId, context))
                  ? jobLoginSection(logins.access.list(agent.id))
                  : undefined,
            } satisfies PromptSection,
          ]
        : []),
    ],
  });

  const extensions = desktop.extensions({
    agentId: agent.id,
    job,
    ...DESKTOP_JOBS,
    ...(agent.desktopModel && { model: modelRef(agent.desktopModel) }),
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
  control?: DesktopControlAccess,
  logins?: DesktopLogins,
  intent?: DesktopIntent,
): CrumblePlugin => {
  const desktop = defineJobKind(JOB_KINDS.desktop);

  const jobs: DesktopJobs = {
    desktop,
    tools: new Map(),
    control,
    logins,
    intent,
  };

  return {
    id: "desktop",
    jobKinds: workspaces?.desktop
      ? [
          {
            kind: desktop.kind,
            enabled: usesDesktop,
            extensions: (agent) => desktopExtensions(jobs, agent),
            env: (agentId, target, context) =>
              desktop.env(workspaces, agentId, target, context),
            onAnswer: desktop.onAnswer,
          },
        ]
      : [],
  };
};
