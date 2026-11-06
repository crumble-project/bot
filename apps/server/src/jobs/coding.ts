import type { Context } from "@earendil-works/chord";
import {
  ToolTask,
  defineExtension,
  hook,
  type PromptSection,
} from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Effect } from "effect";
import {
  credentialExtension,
  type CredentialsAccess,
} from "../credentials/credentials";
import type { Agent } from "../contract/agents";
import { defineJobKind, type JobExtensions, type JobKind } from "./jobs";
import { JOB_KINDS } from "../shared/job-kinds";
import type { CrumblePlugin } from "../plugins/plugins";
import { WORKSPACE_PATH } from "../../workspace-image/guest";
import type { Workspaces } from "../workspaces/workspace";
import {
  chatWorkspaceSection,
  SETSID_COMMAND,
  workspaceNotesSection,
} from "./workspace-notes";
import { BOT_TOOL } from "../contract/tools";

const WORKSPACE_EXTENSION = "workspace";

// Tools whose success may have changed the workspace's files. A failed bash can still have written files.
const FILE_CHANGING_TOOLS = new Set(["write", "edit", "bash"]);

const CODING_JOBS = {
  description:
    `Run coding jobs: background agents with their own read, write, edit, and bash in your workspace (${WORKSPACE_PATH}). ` +
    "Do coding work yourself with those tools. Start a job only for work that runs beside you: several tasks at once, or a task that would block this chat for long. " +
    "Actions: start (name, message: the task and what only you know about it; the job already sees your standing instructions, memory, skills, and the latest messages of this chat), send (name, message; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
    "Starting a job or sending it a message ends your turn, and the owner sees the job as a card, so write anything else the owner needs before the call and do not describe the job. " +
    "Jobs keep working after your turn ends. Their final answer arrives later as a message from the job; then tell the owner the outcome. Do not wait or poll for it. " +
    "A server you or a job start keeps running on localhost, for you and later jobs, desktop jobs included, until the workspace stops while idle; start it again with the command reported for it.",
  instructions: [
    `You are a coding job for another bot. Do the task you are given with your read, write, edit, and bash tools, working in ${WORKSPACE_PATH}, a persistent workspace that earlier jobs of this bot also used.`,
    `To leave a server or other long-running program for later jobs, start it in its own session with its output in a log file: ${SETSID_COMMAND} Started any other way, it dies when your command ends or is stopped. Check that it answers before you report.`,
    "For browser tests, use the workspace's Chromium if `command -v chromium` finds one: install Playwright with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 and launch chromium with executablePath set to that path.",
    "Before cloning a repository, check whether earlier jobs left a clone in the workspace: reuse it, fetch, and branch from the remote's default branch. Reinstall dependencies only when the lockfile changed since the last install.",
    "Change files with the edit tool, not with sed or a script that replaces strings. Don't print a file you already read in this job again unless it changed since.",
    "Work without asking: follow the task, the repository's own instructions, and your skills. Use ask_owner only when the answer changes what you build or a decision is the owner's to make, and keep working on anything that doesn't depend on it before you ask.",
    "Verify your work by running it. Finish with a short report: what you did, what you verified, and what is left. For a server you left running, include its URL and the command that starts it again.",
  ].join(" "),
};

const credentialSection = (
  key: string,
  agentId: string,
  credentials: CredentialsAccess,
  applies: (
    input: Parameters<PromptSection["render"]>[0],
    context: Context,
  ) => Promise<boolean> = async () => true,
): PromptSection => ({
  key,
  render: async (input, context) =>
    (await applies(input, context))
      ? credentials.workspaceSection(agentId)
      : undefined,
});

// A crash then loses at most the call in flight.
const syncAfter = (workspaces: Workspaces, agentId: string, name: string) =>
  FILE_CHANGING_TOOLS.has(name)
    ? Effect.runPromise(workspaces.sync(agentId))
    : Promise.resolve();

// Holds the workspace awake for the grace period after a job asks; wake ends the hold early.
const questionHold = (
  coding: JobKind,
  agentId: string,
  workspaces: Workspaces,
  questionGraceMs: () => number,
) => {
  let awake:
    | { release: () => void; timer: ReturnType<typeof setTimeout> }
    | undefined;

  const wake = () => {
    if (!awake) return;
    clearTimeout(awake.timer);
    awake.release();
    awake = undefined;
  };

  const ask = coding.questionTool(() => {
    wake();
    const release = workspaces.keepAwake(agentId);
    const timer = setTimeout(wake, questionGraceMs());

    timer.unref();
    awake = { release, timer };
  });

  return { ask, wake };
};

type CodingTools = NonNullable<ReturnType<typeof createCodingTools>["tools"]>;

type CodingBuild = {
  coding: JobKind;
  agentId: string;
  workspaces: Workspaces;
  credentials: CredentialsAccess;
};

// The chat selects every installed extension, this one included, so its sections and hook check for a job.
const jobExtension = (
  { coding, agentId, workspaces, credentials }: CodingBuild,
  tools: CodingTools,
  { ask, wake }: ReturnType<typeof questionHold>,
) =>
  defineExtension({
    name: JOB_KINDS.coding.extension,
    tools: [...tools, ask],
    sections: [
      workspaceNotesSection(coding.isJob, true),
      credentialSection(
        "workspace_credentials",
        agentId,
        credentials,
        (input, context) =>
          coding.isJob(input.read, input.conversationId, context),
      ),
    ],
    hooks: [
      hook(ToolTask, {
        afterTool: async (call, _result, api, context) => {
          if (!(await coding.isJob(api, api.conversationId, context)))
            return undefined;

          wake();
          await syncAfter(workspaces, agentId, call.name);

          return undefined;
        },
      }),
    ],
  });

const workspaceExtension = (
  { agentId, workspaces, credentials }: CodingBuild,
  tools: CodingTools,
) =>
  defineExtension({
    name: WORKSPACE_EXTENSION,
    tools,
    sections: [
      chatWorkspaceSection(() => workspaces.running(agentId)),
      credentialSection("shell_credentials", agentId, credentials),
    ],
    hooks: [
      hook(ToolTask, {
        afterTool: async (call) => {
          await syncAfter(workspaces, agentId, call.name);

          return undefined;
        },
      }),
    ],
  });

function codingExtensions(
  coding: JobKind,
  agent: Pick<Agent, "id">,
  workspaces: Workspaces,
  questionGraceMs: () => number,
  credentials: CredentialsAccess,
): JobExtensions {
  const build = { coding, agentId: agent.id, workspaces, credentials };

  const hold = questionHold(coding, agent.id, workspaces, questionGraceMs);
  const tools = createCodingTools().tools ?? [];
  const job = jobExtension(build, tools, hold);
  const own = workspaceExtension(build, tools);

  const extensions = coding.extensions({
    agentId: agent.id,
    job,
    ...CODING_JOBS,
  });

  return {
    ...extensions,
    chat: [own, ...extensions.chat, credentialExtension(agent.id, credentials)],
  };
}

export const codingPlugin = (
  workspaces: Workspaces | undefined,
  questionGraceMs: () => number,
  credentials: CredentialsAccess,
): CrumblePlugin => {
  const coding = defineJobKind(JOB_KINDS.coding);
  // One build per bot: the grace period's hold lives in its closure, and a later build could not release it.
  const built = new Map<string, JobExtensions>();

  return {
    id: "coding",
    jobKinds: workspaces
      ? [
          {
            kind: coding.kind,
            enabled: (agent) => agent.tools.includes(BOT_TOOL.coding),
            extensions: (agent) => {
              const extensions =
                built.get(agent.id) ??
                codingExtensions(
                  coding,
                  agent,
                  workspaces,
                  questionGraceMs,
                  credentials,
                );

              built.set(agent.id, extensions);

              return extensions;
            },
            env: (agentId, target, context) =>
              coding.env(
                workspaces,
                agentId,
                target,
                context,
                credentials.env(agentId),
              ),
            botEnv: (agentId) =>
              workspaces.env(agentId, credentials.env(agentId)),
            onAnswer: coding.onAnswer,
            onQuestion: coding.onQuestion,
            onFinished: coding.onFinished,
          },
        ]
      : [],
  };
};
