import type { Context } from "@earendil-works/chord";
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
import type { Agent } from "./domain";
import { defineJobKind, type JobExtensions, type JobInfo } from "./jobs";
import type { CrumblePlugin } from "./plugins";
import { WORKSPACE_PATH, type Workspaces } from "./workspace";

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
    "Jobs keep working after your turn ends. Their final answer arrives later as a message from the job; then tell the owner the outcome. Do not wait or poll for it.",
  instructions: `You are a coding job for another bot. Do the task you are given with your read, write, edit, and bash tools, working in ${WORKSPACE_PATH}, a persistent workspace that earlier jobs of this bot also used. Verify your work by running it. Finish with a short report: what you did, what you verified, and what is left.`,
});

/** The job a successful `coding` result shows as a card; a listing or a failed call shows none. */
export const codingJobOf = coding.jobOf;

/** Hears the bot's answer to each coding job report, for notifications. */
export const codingAnswers = coding.onAnswer;

export type CodingJobInfo = JobInfo;

export type CodingExtensions = JobExtensions;

export const codingJobs = (harness: Harness, chatId: ConversationId) =>
  coding.list(harness, chatId);

export const codingEnv = (
  workspaces: Workspaces,
  agentId: string,
  target: EnvTarget,
  context: Context,
): Promise<ExecutionEnv | undefined> =>
  coding.env(workspaces, agentId, target, context);

/** Lets a bot run coding jobs: child conversations with Pi's coding tools in the bot's workspace. */
export function codingExtensions(
  agent: Pick<Agent, "id">,
  workspaces: Workspaces,
): CodingExtensions {
  const job = defineExtension({
    name: "coding-job",
    tools: createCodingTools().tools,
    hooks: [
      hook(ToolTask, {
        // A crash then loses at most the call in flight.
        afterTool: async (call, _result, api, context) => {
          if (!FILE_CHANGING_TOOLS.has(call.name)) return undefined;

          if (await coding.isJob(api, api.conversationId, context))
            await workspaces.sync(agent.id, context);

          return undefined;
        },
      }),
    ],
  });

  return coding.extensions({ agentId: agent.id, job });
}

/** Coding jobs as a plugin: offered to bots with the `coding` tool while workspaces are available. */
export const codingPlugin = (
  workspaces: Workspaces | undefined,
): CrumblePlugin => ({
  id: "coding",
  jobKinds: workspaces
    ? [
        {
          kind: "coding",
          enabled: (agent) => agent.tools.includes(CODING_TOOL_NAME),
          extensions: (agent) => codingExtensions(agent, workspaces),
          env: (agentId, target, context) =>
            codingEnv(workspaces, agentId, target, context),
          onAnswer: codingAnswers,
        },
      ]
    : [],
});
