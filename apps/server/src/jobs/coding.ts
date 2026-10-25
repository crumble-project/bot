import type { Context } from "@earendil-works/chord";
import { Effect } from "effect";
import {
  ToolTask,
  defineExtension,
  hook,
  type ConversationId,
  type EnvTarget,
  type Harness,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import {
  credentialExtension,
  jobCredentialSection,
  type CredentialsAccess,
} from "../credentials/credentials";
import type { Agent } from "../shared/domain";
import { defineJobKind, type JobExtensions, type JobInfo } from "./jobs";
import type { CrumblePlugin } from "../app/plugins";
import { WORKSPACE_PATH, type Workspaces } from "../workspaces/workspace";

export const CODING_TOOL_NAME = "coding";

// Tools whose success may have changed the workspace's files. A failed bash can still have written files.
const FILE_CHANGING_TOOLS = new Set(["write", "edit", "bash"]);

const coding = defineJobKind({
  kind: "coding",
  toolName: CODING_TOOL_NAME,
  label: "coding job",
  description:
    `Run coding jobs: background agents that read, write, edit files and run shell commands in your persistent workspace (${WORKSPACE_PATH}), which survives restarts and is shared by all your jobs. ` +
    "Actions: start (name, message: the full task, since the job knows nothing else), send (name, message; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
    "Starting a job or sending it a message ends your turn, and the owner sees the job as a card, so write anything else the owner needs before the call and do not describe the job. " +
    "Jobs keep working after your turn ends. Their final answer arrives later as a message from the job; then tell the owner the outcome. Do not wait or poll for it. " +
    "A server a job starts keeps running on localhost for later jobs, desktop jobs included, until the workspace stops while idle; a job starts it again with the command it reported.",
  instructions: [
    `You are a coding job for another bot. Do the task you are given with your read, write, edit, and bash tools, working in ${WORKSPACE_PATH}, a persistent workspace that earlier jobs of this bot also used.`,
    `To leave a server or other long-running program for later jobs, start it in its own session with its output in a log file: setsid <command> > ${WORKSPACE_PATH}/<name>.log 2>&1 < /dev/null &. Started any other way, it dies when your command ends or is stopped. Check that it answers before you report.`,
    "For browser tests, use the workspace's Chromium if `command -v chromium` finds one: install Playwright with PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 and launch chromium with executablePath set to that path.",
    "Verify your work by running it. Finish with a short report: what you did, what you verified, and what is left. For a server you left running, include its URL and the command that starts it again.",
  ].join(" "),
});

/** The job a successful `coding` result shows as a card; a listing or a failed call shows none. */
export const codingJobOf = coding.jobOf;

/** Hears the bot's answer to each coding job report, for notifications. */
export const codingAnswers = coding.onAnswer;

export type CodingJobInfo = JobInfo;

export type CodingExtensions = JobExtensions;

export const codingJobs = (harness: Harness, chatId: ConversationId) =>
  coding.list(harness, chatId);

export async function codingEnv(
  workspaces: Workspaces,
  agentId: string,
  target: EnvTarget,
  context: Context,
  credentials?: CredentialsAccess,
): Promise<ExecutionEnv | undefined> {
  return coding.env(
    workspaces,
    agentId,
    target,
    context,
    credentials?.env(agentId),
  );
}

/** Lets a bot run coding jobs: child conversations with Pi's coding tools in the bot's workspace. */
export function codingExtensions(
  agent: Pick<Agent, "id">,
  workspaces: Workspaces,
  credentials?: CredentialsAccess,
): CodingExtensions {
  const job = defineExtension({
    name: "coding-job",
    tools: createCodingTools().tools ?? [],
    sections: credentials
      ? [
          {
            key: "workspace_credentials",
            // Installed job extensions render in the bot's chat too; only a job needs this.
            render: async (input, context) =>
              (await coding.isJob(input.read, input.conversationId, context))
                ? jobCredentialSection(credentials.list(agent.id).credentials)
                : undefined,
          },
        ]
      : [],
    hooks: [
      hook(ToolTask, {
        // A crash then loses at most the call in flight.
        afterTool: async (call, _result, api, context) => {
          if (!FILE_CHANGING_TOOLS.has(call.name)) return undefined;

          if (await coding.isJob(api, api.conversationId, context))
            await Effect.runPromise(workspaces.sync(agent.id));

          return undefined;
        },
      }),
    ],
  });

  const extensions = coding.extensions({ agentId: agent.id, job });

  return credentials
    ? {
        ...extensions,
        chat: [...extensions.chat, credentialExtension(agent.id, credentials)],
      }
    : extensions;
}

/** Coding jobs as a plugin: offered to bots with the `coding` tool while workspaces are available. */
export const codingPlugin = (
  workspaces: Workspaces | undefined,
  credentials?: CredentialsAccess,
): CrumblePlugin => ({
  id: "coding",
  jobKinds: workspaces
    ? [
        {
          kind: "coding",
          enabled: (agent) => agent.tools.includes(CODING_TOOL_NAME),
          extensions: (agent) =>
            codingExtensions(agent, workspaces, credentials),
          env: (agentId, target, context) =>
            codingEnv(workspaces, agentId, target, context, credentials),
          onAnswer: codingAnswers,
        },
      ]
    : [],
});
