import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
} from "@earendil-works/chord/context";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  UsageDoc,
  type ConversationId,
  type DocumentReader,
  type EntryId,
  type EnvTarget,
  type Extension,
  type Harness,
  type ModelRef,
  type TaskId,
  type ToolExecutionApi,
  type ToolExecutionResult,
  type Tx,
  type UsageState,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { z } from "zod";
import { conversationReference } from "../shared/domain";
import { defineAnchorTask } from "../shared/anchor-task";
import { WORKSPACE_PATH, type Workspaces } from "../workspaces/workspace";

export type JobKindOptions = {
  /** Names the kind's documents, tasks, request IDs, and message origin. Stored data depends on it: never rename. */
  kind: string;
  toolName: string;
  /** Lowercase noun for tool output and reports, such as "coding job". */
  label: string;
  /** The job tool's description for the bot's model. */
  description: string;
  /** The job's own instructions. */
  instructions: string;
  /** One job works at a time: a message to a job waits while another job of this kind works. */
  exclusive?: boolean;
};

export type JobInfo = {
  name: string;
  conversationId: ConversationId;
  status: "working" | "idle";
};

/** A job in a listing, with what its own model requests and tools spent; none before its first request. */
export type ListedJob = JobInfo & { usage?: UsageState };

export type JobExtensions = {
  /** Offered in the bot's chat: the job tool. */
  chat: Extension[];
  /** Installed only: selected by the jobs themselves, never offered in the chat. */
  job: Extension[];
};

type Job = {
  conversationId: ConversationId;
  /** Answers already reported to the bot: several messages can end in one answer, reported once. */
  reported: EntryId[];
  /** Times the job was stopped; a delivery created before the latest stop is dropped. Unset means zero. */
  stops?: number;
  /**
   * Deliveries not yet admitted to the job, by reporter task ID: waiting for their turn, or submitting right now. A job
   * with any counts as working, and stop waits for submitting ones so its abort covers their work.
   */
  deliveries?: Record<string, "waiting" | "submitting">;
};

/** The job an exclusive kind's screen belongs to, and how many of its deliveries are in flight. */
type Holder = { name: string; deliveries: number };

type JobsState = { jobs: Record<string, Job>; holder?: Holder };

/** The bot's answer to a job's report: what a notification about the job shows. */
export type JobAnswer = {
  agentId: string;
  /** The job kind, such as `coding` or `desktop`. */
  kind: string;
  /** The job's name. */
  name: string;
  entryId: string;
  preview: string;
  /** Stable per report, so a repeated announcement can be recognized. */
  eventId: string;
};

type ReporterInput = {
  /** The bot, for announcing its answer to the report. Unset in deliveries created before announcements existed. */
  agentId?: string;
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
  /** The job's stop count when this delivery was created. Unset means zero. */
  stops?: number;
};

type ReporterState =
  | { phase: "wait" }
  | { phase: "deliver" }
  | { phase: "report"; report?: string | undefined }
  | { phase: "announce"; entryId: string; preview: string };

const jobCard = z.object({ name: z.string().min(1) });

const WAIT_MS = 1000;
const STOP_POLL_MS = 50;
// A delivery that crashed while submitting stays marked; stop aborts after this long anyway.

const STOP_WAIT_MS = 10_000;

const textOf = (message: AssistantMessage | undefined) =>
  (message?.content ?? [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");

const releaseHolder = (state: JobsState, name: string) => {
  if (state.holder?.name !== name) return;
  state.holder.deliveries -= 1;

  if (state.holder.deliveries <= 0) delete state.holder;
};

const settleDelivery = (job: Job | undefined, reporterId: TaskId<null>) => {
  if (job?.deliveries) delete job.deliveries[String(reporterId)];
};

// A job is busy while it has a run, from an input until its final answer, or a delivery that will start one.
const statusOf = async (reader: DocumentReader, job: Job, context: Context) =>
  Object.keys(job.deliveries ?? {}).length > 0 ||
  (await reader.snapshot(LiveDoc, job.conversationId, context))?.run
    ? ("working" as const)
    : ("idle" as const);

/** The job a call names, as the tool's details: what a client's job card shows. */
type JobDetails = {
  name: string;
  status: JobInfo["status"];
  conversationId: string;
};

/** How the tool answers one call: text for the model, and the card's job when the call names one. */
type Reply = (text: string, found?: JobInfo) => ToolExecutionResult<JobDetails>;

/** One call of the job tool: the bot it answers, the jobs it read, and how to answer. */
type JobToolCall = {
  agentId: string;
  api: ToolExecutionApi;
  context: Context;
  /** The jobs of the bot's chat, as the call read them. */
  jobs: JobsState["jobs"];
  reply: Reply;
};

/** A start or send call: the job to create or message, and what a job it starts runs with. */
type StartOrSend = {
  action: "start" | "send";
  name: string;
  message: string;
  followUp: boolean;
  /** The job's own extension: its tools and hooks. */
  job: Extension;
  /** The job's model; unset, a job starts with the bot's model. */
  model: ModelRef | undefined;
};

/** What a start or send did, and the job its card shows. */
type Started = { text: string; found: JobInfo | undefined };

// Both tasks belong to the bot's chat and are background: its Esc and idle waits skip them.
const BACKGROUND = {
  ownership: { kind: "conversation" },
  background: true,
} as const;

function jobReply(
  agentId: string,
  text: string,
  found?: JobInfo,
): ToolExecutionResult<JobDetails> {
  const result = { output: [{ type: "text" as const, text }] };

  if (!found) return result;

  // Clients attach a job card to the job's conversation through the details.
  return {
    ...result,
    details: {
      name: found.name,
      status: found.status,
      conversationId: conversationReference(
        agentId,
        Number(found.conversationId),
      ),
    },
  };
}

export type JobKind = ReturnType<typeof defineJobKind>;

/** Background jobs a bot hands work to: child conversations of its chat, built on Pi Durable's background subagent pattern. */
export function defineJobKind(options: JobKindOptions) {
  const { kind, toolName, label } = options;
  const answerListeners = new Set<(answer: JobAnswer) => void>();

  /** Marks a conversation as a job of this kind; its environment is the bot's workspace. */
  const Marker = defineDoc<{ job: boolean }>({
    kind: `crumble.${kind}-job`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ job: false }),
    checkpointWhen: () => false,
  });

  const Jobs = defineDoc<JobsState>({
    kind: `crumble.${kind}-jobs`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ jobs: {} }),
    // Every job's status change is a delta; a periodic full value bounds the replay on open.
    checkpointWhen: (_value, _ops, { deltasSinceBase }) =>
      deltasSinceBase >= 32,
  });

  // A delivery is stopped when its job is gone or was stopped after the delivery was queued.
  const deliveryTarget = async (
    tx: Tx,
    chatId: ConversationId,
    name: string,
    stops: number,
  ) => {
    const state = await tx.doc(Jobs, chatId);
    const job = state.jobs[name];

    return !job || (job.stops ?? 0) !== stops
      ? { state, job, stopped: true as const }
      : { state, job, stopped: false as const };
  };

  // The job's conversation is owned by this task so it outlives the bot's turns and Esc.
  const Anchor = defineAnchorTask(`crumble.${kind}-anchor`);

  // Delivers one message to a job and reports its answer to the bot. Request IDs keep a restart from delivering the
  // message or the report twice.
  const Reporter = defineTask<ReporterInput, ReporterState, null>({
    name: `crumble.${kind}-reporter`,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      // Drops a delivery whose job was stopped since, and for an exclusive kind takes the screen in the same commit,
      // so two waiting deliveries cannot both pass. A restart re-enters this phase and waits again.
      wait: async (reporter, runtime, taskContext) => {
        const { name, stops = 0 } = reporter.input;

        for (;;) {
          let waiting = false;

          await runtime.commit(async (tx) => {
            const { state, job, stopped } = await deliveryTarget(
              tx,
              runtime.conversationId,
              name,
              stops,
            );

            if (stopped) {
              settleDelivery(job, reporter.id);

              return {
                status: "terminal",
                outcome: { status: "completed", result: null },
              };
            }

            if (options.exclusive) {
              if (state.holder && state.holder.name !== name) {
                waiting = true;

                return undefined;
              }

              state.holder = {
                name,
                deliveries: (state.holder?.deliveries ?? 0) + 1,
              };
            }

            return { status: "running", checkpoint: { phase: "deliver" } };
          }, taskContext);

          if (!waiting) return;

          await awaitWithContext(
            new Promise((resolve) => setTimeout(resolve, WAIT_MS)),
            taskContext,
          );
        }
      },
      // Admission checks the stop count and marks the delivery as submitting in one commit; stop waits for submitting
      // deliveries before it aborts. So work is either never submitted, or submitted before the abort that cancels it.
      deliver: async (reporter, runtime, taskContext) => {
        const { name, conversationId, message, followUp } = reporter.input;
        let admitted = false;

        await runtime.commit(async (tx) => {
          const { state, job, stopped } = await deliveryTarget(
            tx,
            runtime.conversationId,
            name,
            reporter.input.stops ?? 0,
          );

          if (stopped) {
            settleDelivery(job, reporter.id);
            releaseHolder(state, name);

            return { status: "running", checkpoint: { phase: "report" } };
          }

          job.deliveries = {
            ...job.deliveries,
            [String(reporter.id)]: "submitting",
          };
          admitted = true;

          return undefined;
        }, taskContext);

        if (!admitted) return;

        const job = (await runtime.conversation(conversationId, taskContext))!;

        const submission = await job.submit(
          {
            type: "input",
            content: message,
            whenBusy: followUp ? "followUp" : "steer",
            requestId: `${kind}:${reporter.id}`,
          },
          taskContext,
        );

        await runtime.commit(async (tx) => {
          settleDelivery(
            (await tx.doc(Jobs, runtime.conversationId)).jobs[name],
            reporter.id,
          );
        }, taskContext);

        const settled = await submission.wait(taskContext);

        await runtime.commit(async (tx) => {
          const state = await tx.doc(Jobs, runtime.conversationId);

          // The answer frees the screen for the next job, whether it reports or not.
          releaseHolder(state, name);

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
                : `[${label} ${name} failed: ${settled.reason}]`,
            );

          if (settled.type !== "input") return next();
          const job = state.jobs[name];

          if (!job || job.reported.includes(settled.answer)) return next();
          job.reported.push(settled.answer);

          const answer = (await tx.entry(AssistantEntry, settled.answer))
            ?.model?.[0];

          return next(
            `[${label} ${name} finished] ${answer?.role === "assistant" ? textOf(answer) : ""}`,
          );
        }, taskContext);
      },
      report: async (reporter, runtime, taskContext) => {
        const { report } = reporter.state.checkpoint;

        if (report === undefined)
          return runtime.commit(
            () => ({
              status: "terminal",
              outcome: { status: "completed", result: null },
            }),
            taskContext,
          );

        const chat = (await runtime.conversation(
          runtime.conversationId,
          taskContext,
        ))!;

        // The model reads the framed report; the owner sees the job's words, labelled with their origin.
        const text = report.replace(/^\[[^\]]*\] ?/, "");

        const submission = await chat.submit(
          {
            type: "input",
            content: report,
            whenBusy: "followUp",
            requestId: `${kind}-report:${reporter.id}`,
            entry: {
              kind: "crumble.message",
              data: { text, origin: { kind, name: reporter.input.name } },
            },
          },
          taskContext,
        );

        // The bot's answer to the report is what the owner is notified about, such as a job asking for them.
        const settled = await submission.wait(taskContext);

        await runtime.commit(async (tx) => {
          const done = {
            status: "terminal",
            outcome: { status: "completed", result: null },
          } as const;

          if (settled.status === "unanswered" || settled.type !== "input")
            return done;

          const answer = (await tx.entry(AssistantEntry, settled.answer))
            ?.model?.[0];

          const preview =
            answer?.role === "assistant" ? textOf(answer).trim() : "";

          // A reaction or a tool call alone is no answer worth a notification.
          if (!preview) return done;

          return {
            status: "running",
            checkpoint: {
              phase: "announce",
              entryId: String(settled.answer),
              preview: preview.slice(0, 240),
            },
          };
        }, taskContext);
      },
      announce: async (reporter, runtime, taskContext) => {
        const { entryId, preview } = reporter.state.checkpoint;
        const { agentId, name } = reporter.input;

        if (agentId)
          for (const listener of answerListeners)
            listener({
              agentId,
              kind,
              name,
              entryId,
              preview,
              eventId: `${kind}-report:${reporter.id}`,
            });

        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          taskContext,
        );
      },
    },
    abort: (reporter, runtime, taskContext) =>
      runtime.commit(async (tx) => {
        const state = await tx.doc(Jobs, runtime.conversationId);

        settleDelivery(state.jobs[reporter.input.name], reporter.id);

        // An aborted delivery that held the screen frees it.
        if (reporter.state.checkpoint.phase === "deliver")
          releaseHolder(state, reporter.input.name);

        return { status: "terminal", outcome: { status: "aborted" } };
      }, taskContext),
  });

  /** Starts the job's own conversation as a copy of the bot's agent; false when the name is taken. */
  const startJob = async (tx: Tx, request: StartOrSend, state: JobsState) => {
    const { name, job, model } = request;

    if (Object.hasOwn(state.jobs, name)) return false;

    const anchor = await tx.createTask(Anchor, null, BACKGROUND);

    // Starts as a copy of the bot's agent, then keeps only the job's own tools. Selecting exactly the job extension
    // also drops the bot's other tools, hooks, and prompt sections, so a job can neither start jobs nor delegate,
    // schedule, or reach integrations.
    const child = await tx.createConversation({
      ownership: { kind: "task", taskId: anchor },
    });

    await configure(tx, child.id, {
      extensions: [job],
      tools: null,
      modelTools: null,
      instructions: options.instructions,
      cwd: WORKSPACE_PATH,
      ...(model && { model }),
    });
    (await tx.doc(Marker, child.id)).job = true;
    state.jobs[name] = { conversationId: child.id, reported: [] };

    return true;
  };

  /** Whether a delivery of the job is submitting right now, which an abort must wait for. */
  const submitting = async (
    api: ToolExecutionApi,
    context: Context,
    name: string,
  ) =>
    Object.values(
      (await api.snapshot(Jobs, api.conversationId, context))?.jobs[name]
        ?.deliveries ?? {},
    ).includes("submitting");

  /** Drops deliveries still waiting for the screen, then aborts the job's current answer and tools and its queued
   * messages. It stays usable. */
  const stopJob = async (call: JobToolCall, existing: Job, name: string) => {
    const { api, context, reply } = call;

    await api.commit(async (tx) => {
      const job = (await tx.doc(Jobs, api.conversationId)).jobs[name];

      if (job) job.stops = (job.stops ?? 0) + 1;
    }, context);

    // A delivery admitted before the stop count changed finishes submitting first, so the abort covers it.
    for (
      let waited = 0;
      waited < STOP_WAIT_MS && (await submitting(api, context, name));
      waited += STOP_POLL_MS
    )
      await awaitWithContext(
        new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS)),
        context,
      );

    await (await api.conversation(existing.conversationId, context))!.abort(
      context,
    );

    return reply(`Stopped ${name}.`, {
      name,
      conversationId: existing.conversationId,
      status: "idle",
    });
  };

  /** Starts a job or messages an existing one, admitting its delivery before it answers. */
  const startOrSend = async (
    call: JobToolCall,
    request: StartOrSend,
  ): Promise<Started> => {
    const { agentId, api, context } = call;

    return api.commit(async (tx): Promise<Started> => {
      const state = await tx.doc(Jobs, api.conversationId);

      if (request.action === "start" && !(await startJob(tx, request, state)))
        return {
          text: `${request.name} already exists; use send.`,
          found: undefined,
        };

      const record = state.jobs[request.name]!;
      const conversationId = record.conversationId;

      const reporter = await tx.createTask(
        Reporter,
        {
          agentId,
          name: request.name,
          conversationId,
          message: request.message,
          followUp: request.action === "send" && request.followUp,
          stops: record.stops ?? 0,
        },
        BACKGROUND,
      );

      record.deliveries = {
        ...record.deliveries,
        [String(reporter)]: "waiting",
      };

      return {
        text:
          request.action === "send"
            ? `Sent to ${request.name}.`
            : `Started ${request.name}.`,
        found: {
          name: request.name,
          conversationId,
          status: "working" as const,
        },
      };
    }, context);
  };

  /** The jobs the call names, or all of them, oldest first, with the status of each. */
  const statusReply = async (call: JobToolCall, name: string | undefined) => {
    const { api, context, jobs, reply } = call;
    const names = name === undefined ? Object.keys(jobs) : [name];
    const found: JobInfo[] = [];

    for (const each of names) {
      const job = Object.hasOwn(jobs, each) ? jobs[each] : undefined;

      if (job)
        found.push({
          name: each,
          conversationId: job.conversationId,
          status: await statusOf(api, job, context),
        });
    }

    const text = found.length
      ? found.map((each) => `${each.name}: ${each.status}`).join("\n")
      : `No ${label}s.`;

    // Details describe one job; a listing has none.
    return reply(text, name === undefined ? undefined : found[0]);
  };

  return {
    toolName,

    /** Hears the bot's answer to each report of a job of this kind, from every bot in this process. */
    onAnswer: (listener: (answer: JobAnswer) => void) => {
      answerListeners.add(listener);

      return () => void answerListeners.delete(listener);
    },

    /** The job a successful tool result shows as a card; a listing or a failed call shows none. */
    jobOf: (message: {
      role: string;
      toolName?: string | undefined;
      isError?: boolean | undefined;
      toolDetails?: unknown;
    }): string | undefined => {
      if (
        message.role !== "toolResult" ||
        message.toolName !== toolName ||
        message.isError
      )
        return undefined;

      return jobCard.safeParse(message.toolDetails).data?.name;
    },

    /** The jobs of a bot's chat, oldest first: conversation IDs only grow, whereas record keys reorder numeric names. */
    async list(harness: Harness, chatId: ConversationId): Promise<ListedJob[]> {
      const jobs =
        (await harness.snapshot(Jobs, chatId, BACKGROUND_CONTEXT))?.jobs ?? {};

      const found = await Promise.all(
        Object.entries(jobs).map(async ([name, job]) => {
          const listed: ListedJob = {
            name,
            conversationId: job.conversationId,
            status: await statusOf(harness, job, BACKGROUND_CONTEXT),
          };

          const usage = await harness.snapshot(
            UsageDoc,
            job.conversationId,
            BACKGROUND_CONTEXT,
          );

          return usage ? { ...listed, usage } : listed;
        }),
      );

      return found.sort(
        (a, b) => Number(a.conversationId) - Number(b.conversationId),
      );
    },

    /** Whether the conversation is a job of this kind. */
    async isJob(
      reader: DocumentReader,
      conversationId: ConversationId,
      context: Context,
    ) {
      return (
        (await reader.snapshot(Marker, conversationId, context))?.job === true
      );
    },

    /**
     * A job's environment is its bot's workspace. Any other conversation, such as the bot's chat, gets none, so a
     * tool that wrongly reached for a shell would fail instead of touching the workspace.
     */
    async env(
      workspaces: Workspaces,
      agentId: string,
      target: EnvTarget,
      context: Context,
      shellEnv?: Record<string, string>,
    ): Promise<ExecutionEnv | undefined> {
      const marker = await target.read.snapshot(
        Marker,
        target.conversationId,
        context,
      );

      return marker?.job ? workspaces.env(agentId, shellEnv) : undefined;
    },

    extensions(input: {
      agentId: string;
      /** The job's own extension: its tools and hooks. */
      job: Extension;
      /** The job's model; unset, a job starts with the bot's model. */
      model?: ModelRef;
    }): JobExtensions {
      const { agentId, job } = input;

      const tool = defineTool({
        name: toolName,
        description: options.description,
        parameters: Type.Object({
          action: Type.Union([
            Type.Literal("start"),
            Type.Literal("send"),
            Type.Literal("stop"),
            Type.Literal("status"),
          ]),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
          message: Type.Optional(
            Type.String({ minLength: 1, maxLength: 32000 }),
          ),
          followUp: Type.Optional(Type.Boolean()),
        }),
        callers: ["model"],
        // A rerun of stop or send after a crash could hit newer work; the model can check with status.
        replay: "unsafe",
        execute: async (args, api, callContext) => {
          const { action, name, message } = args;

          const jobs =
            (await api.snapshot(Jobs, api.conversationId, callContext))?.jobs ??
            {};

          const call: JobToolCall = {
            agentId,
            api,
            context: callContext,
            jobs,
            reply: (text, found) => jobReply(agentId, text, found),
          };

          if (action === "status") return statusReply(call, name);

          if (name === undefined) return call.reply(`${action} needs a name.`);
          const existing = Object.hasOwn(jobs, name) ? jobs[name] : undefined;

          if (action !== "start" && !existing)
            return call.reply(`No ${label} named ${name}.`);

          if (action === "stop") return stopJob(call, existing!, name);

          if (message === undefined)
            return call.reply(`${action} needs a message.`);

          const result = await startOrSend(call, {
            action,
            name,
            message,
            followUp: args.followUp === true,
            job,
            model: input.model,
          });

          // The card shows the started or messaged job, so the turn ends with it, as after `show`.
          return result.found
            ? {
                ...call.reply(result.text, result.found),
                control: { terminate: true },
              }
            : call.reply(result.text);
        },
      });

      const chat = defineExtension({
        name: toolName,
        tools: [tool],
        tasks: [Anchor, Reporter],
      });

      return { chat: [chat], job: [job] };
    },
  };
}
