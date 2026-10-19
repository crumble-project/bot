import type { Context } from "@earendil-works/chord";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  ToolTask,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  hook,
  LiveDoc,
  type ConversationId,
  type EntryId,
  type EnvTarget,
  type Extension,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { Agent } from "./domain";
import { conversationReference } from "./runtime";
import { WORKSPACE_PATH, type Workspaces } from "./workspace";

export const CODING_TOOL_NAME = "coding";

const JOB_INSTRUCTIONS = `You are a coding job for another bot. Do the task you are given with your read, write, edit, and bash tools, working in ${WORKSPACE_PATH}, a persistent workspace that earlier jobs of this bot also used. Verify your work by running it. Finish with a short report: what you did, what you verified, and what is left.`;

// Tools whose success may have changed the workspace's files. A failed bash can still have written files.
const FILE_CHANGING_TOOLS = new Set(["write", "edit", "bash"]);

/** Marks a conversation as a coding job; its environment is the bot's workspace. */
const CodingJob = defineDoc<{ job: boolean }>({
  kind: "crumble.coding-job",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ job: false }),
});

type Job = {
  conversationId: ConversationId;
  /** Answers already reported to the bot: several messages can end in one answer, reported once. */
  reported: EntryId[];
};

const Jobs = defineDoc<{ jobs: Record<string, Job> }>({
  kind: "crumble.coding-jobs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ jobs: {} }),
});

// The job's conversation is owned by this task so it outlives the bot's turns and Esc; see Pi Durable's background
// subagent example.
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "crumble.coding-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, taskContext) =>
      runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }),
        taskContext,
      ),
  },
  abort: (_anchor, runtime, taskContext) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    ),
});

type ReporterInput = {
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
};

type ReporterState =
  | { phase: "deliver" }
  | { phase: "report"; report?: string };

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

// Delivers one message to a job and reports its answer to the bot. Request IDs keep a restart from delivering the
// message or the report twice.
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "crumble.coding-reporter",
  version: 1,
  initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (reporter, runtime, taskContext) => {
      const { name, conversationId, message, followUp } = reporter.input;
      const job = (await runtime.conversation(conversationId, taskContext))!;

      const submission = await job.submit(
        {
          type: "input",
          content: message,
          whenBusy: followUp ? "followUp" : "steer",
          requestId: `coding:${reporter.id}`,
        },
        taskContext,
      );

      const settled = await submission.wait(taskContext);

      await runtime.commit(async (tx) => {
        const next = (report?: string) =>
          ({
            status: "running",
            checkpoint: { phase: "report", report },
          }) as const;

        // Aborted means stopped or withdrawn: nothing to report.
        if (settled.status === "unanswered")
          return next(
            settled.reason === "aborted"
              ? undefined
              : `[coding job ${name} failed: ${settled.reason}]`,
          );

        if (settled.type !== "input") return next();
        const state = await tx.doc(Jobs, runtime.conversationId);
        const job = state.jobs[name];

        if (!job || job.reported.includes(settled.answer)) return next();
        job.reported.push(settled.answer);

        const answer = (await tx.entry(AssistantEntry, settled.answer))
          ?.model?.[0];

        return next(
          `[coding job ${name} finished] ${answer?.role === "assistant" ? textOf(answer) : ""}`,
        );
      }, taskContext);
    },
    report: async (reporter, runtime, taskContext) => {
      const { report } = reporter.state.checkpoint;

      if (report !== undefined) {
        const chat = (await runtime.conversation(
          runtime.conversationId,
          taskContext,
        ))!;

        // The model reads the framed report; the owner sees the job's words, labelled with their origin.
        const text = report.replace(/^\[[^\]]*\] ?/, "");

        await chat.submit(
          {
            type: "input",
            content: report,
            whenBusy: "followUp",
            requestId: `coding-report:${reporter.id}`,
            entry: {
              kind: "crumble.message",
              data: {
                text,
                origin: { kind: "coding", name: reporter.input.name },
              },
            },
          },
          taskContext,
        );
      }

      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: null },
        }),
        taskContext,
      );
    },
  },
  abort: (_reporter, runtime, taskContext) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      taskContext,
    ),
});

/**
 * A coding job's environment is its bot's workspace. Any other conversation, such as the bot's chat, gets none, so
 * a tool that wrongly reached for a shell would fail instead of touching the workspace.
 */
export async function codingEnv(
  workspaces: Workspaces,
  agentId: string,
  target: EnvTarget,
  context: Context,
): Promise<ExecutionEnv | undefined> {
  const marker = await target.read.snapshot(
    CodingJob,
    target.conversationId,
    context,
  );

  return marker?.job ? workspaces.env(agentId) : undefined;
}

export type CodingExtensions = {
  /** Offered in the bot's chat: the job tool. */
  chat: Extension[];
  /** Installed only: selected by the jobs themselves, never offered in the chat. */
  job: Extension[];
};

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

          const marker = await api.snapshot(
            CodingJob,
            api.conversationId,
            context,
          );

          if (marker?.job) await workspaces.sync(agent.id, context);

          return undefined;
        },
      }),
    ],
  });

  const tool = defineTool({
    name: CODING_TOOL_NAME,
    description:
      `Run coding jobs: background agents that read, write, edit files and run shell commands in your persistent workspace (${WORKSPACE_PATH}), which survives restarts and is shared by all your jobs. ` +
      "Actions: start (name, message: the full task, since the job knows nothing else), send (name, message; followUp: true queues it after the current answer instead of steering), stop (name: aborts its current work), status (name, or all jobs without one). " +
      "Jobs keep working after your turn ends. Their final answer arrives later as a message from the job; then tell the owner the outcome. Do not wait or poll for it.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("send"),
        Type.Literal("stop"),
        Type.Literal("status"),
      ]),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
      message: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
      followUp: Type.Optional(Type.Boolean()),
    }),
    callers: ["model"],
    // A rerun of stop or send after a crash could hit newer work; the model can check with status.
    replay: "unsafe",
    execute: async (args, api, callContext) => {
      const { action, name, message, followUp } = args;

      type Found = {
        name: string;
        conversationId: ConversationId;
        status: "working" | "idle";
      };

      const reply = (text: string, found?: Found) => {
        const result = { output: [{ type: "text" as const, text }] };

        if (!found) return result;

        // Clients attach a job card to the job's conversation through the details.
        return {
          ...result,
          details: {
            name: found.name,
            status: found.status,
            conversationId: conversationReference(
              agent.id,
              Number(found.conversationId),
            ),
          },
        };
      };

      const jobs =
        (await api.snapshot(Jobs, api.conversationId, callContext))?.jobs ?? {};

      // A conversation is busy while it has a run: from an input until its final answer.
      const statusOf = async (job: Job) =>
        (await api.snapshot(LiveDoc, job.conversationId, callContext))?.run
          ? ("working" as const)
          : ("idle" as const);

      if (action === "status") {
        const names = name === undefined ? Object.keys(jobs) : [name];
        const found: Found[] = [];

        for (const each of names) {
          const job = Object.hasOwn(jobs, each) ? jobs[each] : undefined;

          if (job)
            found.push({
              name: each,
              conversationId: job.conversationId,
              status: await statusOf(job),
            });
        }

        const text = found.length
          ? found.map((each) => `${each.name}: ${each.status}`).join("\n")
          : "No coding jobs.";

        // Details describe one job; a listing has none.
        return reply(text, name === undefined ? undefined : found[0]);
      }

      if (name === undefined) return reply(`${action} needs a name.`);
      const existing = Object.hasOwn(jobs, name) ? jobs[name] : undefined;

      if (action !== "start" && !existing)
        return reply(`No coding job named ${name}.`);

      if (action === "stop") {
        // Aborts the job's current answer and tools and drops its queued messages. It stays usable.
        await (await api.conversation(
          existing!.conversationId,
          callContext,
        ))!.abort(callContext);

        return reply(`Stopped ${name}.`, {
          name,
          conversationId: existing!.conversationId,
          status: "idle",
        });
      }

      if (message === undefined) return reply(`${action} needs a message.`);

      const result = await api.commit(async (tx) => {
        const state = await tx.doc(Jobs, api.conversationId);

        // Both tasks belong to the bot's chat and are background: its Esc and idle waits skip them.
        const background = {
          ownership: { kind: "conversation" },
          background: true,
        } as const;

        if (action === "start") {
          if (Object.hasOwn(state.jobs, name))
            return {
              text: `${name} already exists; use send.`,
              found: undefined,
            };

          const anchor = await tx.createTask(Anchor, null, background);

          // Starts as a copy of the bot's agent, then keeps only the job's own tools. Selecting exactly the job
          // extension also drops the bot's other tools, hooks, and prompt sections, so a job can neither start jobs
          // nor delegate, schedule, or reach integrations.
          const child = await tx.createConversation({
            ownership: { kind: "task", taskId: anchor },
          });

          await configure(tx, child.id, {
            extensions: [job],
            tools: null,
            modelTools: null,
            instructions: JOB_INSTRUCTIONS,
            cwd: WORKSPACE_PATH,
          });
          (await tx.doc(CodingJob, child.id)).job = true;
          state.jobs[name] = { conversationId: child.id, reported: [] };
        }

        const conversationId = state.jobs[name]!.conversationId;

        await tx.createTask(
          Reporter,
          {
            name,
            conversationId,
            message,
            followUp: action === "send" && followUp === true,
          },
          background,
        );

        return {
          text: action === "send" ? `Sent to ${name}.` : `Started ${name}.`,
          found: { name, conversationId, status: "working" as const },
        };
      }, callContext);

      return reply(result.text, result.found);
    },
  });

  const chat = defineExtension({
    name: "coding",
    tools: [tool],
    tasks: [Anchor, Reporter],
  });

  return { chat: [chat], job: [job] };
}
