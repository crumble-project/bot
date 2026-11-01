import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
} from "@earendil-works/chord/context";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  AgentDoc,
  AssistantEntry,
  configure,
  defineDoc,
  defineExtension,
  defineTask,
  defineTool,
  LiveDoc,
  UsageDoc,
  type ConversationDocToken,
  type ConversationId,
  type DocumentReader,
  type EntryId,
  type EnvTarget,
  type Extension,
  type Harness,
  type ModelRef,
  type NextTaskState,
  type RunningTask,
  type SettledSubmissionRecord,
  type Task,
  type TaskId,
  type TaskRuntime,
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
import {
  addToRequest,
  ownerMessages,
  type JobRequest,
  type OwnerMessage,
} from "./owner-request";

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
  /** Start and send take `owner_messages`, and the job keeps the owner messages it concerns with its tasks. */
  ownerRequest?: boolean;
};

export type JobInfo = {
  name: string;
  conversationId: ConversationId;
  status: "working" | "idle";
};

/** A job in a listing: the model it runs with, and what its own model requests and tools spent, none before its first
 * request. */
export type ListedJob = JobInfo & {
  model?: { provider: string; model: string };
  usage?: UsageState;
};

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

/** How the tool answers one call: text for the model, and the card's job when the call starts one. */
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
  /** Request IDs of the owner messages the call cites. */
  ownerMessages: string[];
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

type JobMarkerDoc = ConversationDocToken<{ job: boolean }>;

type JobsDoc = ConversationDocToken<JobsState>;

type JobRequestDoc = ConversationDocToken<JobRequest>;

type JobAnchor = Task<null, { phase: "done" }, null, object>;

type JobReporter = Task<ReporterInput, ReporterState, null, object>;

/** A reporter phase handler's narrowed running task, its invocation runtime, and its context. */
type ReporterRuntime = TaskRuntime<ReporterInput, ReporterState, null, object>;

type ReporterTask<P extends ReporterState["phase"]> = RunningTask<
  ReporterInput,
  Extract<ReporterState, { phase: P }>,
  null
>;

/** The job tool's caller and the job it works on, as the tool's execute receives them. */
type JobToolInput = {
  agentId: string;
  /** The job's own extension: its tools and hooks. */
  job: Extension;
  /** The job's model; unset, a job starts with the bot's model. */
  model?: ModelRef;
};

type JobToolArgs = {
  action: "start" | "send" | "stop" | "status";
  name?: string;
  message?: string;
  followUp?: boolean;
  owner_messages?: string[];
};

type ToolResultMessage = {
  role: string;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  toolDetails?: unknown;
};

/** Everything a job kind creates once: its documents, its anchor task, and its answer listeners. */
type JobKindBase = {
  options: JobKindOptions;
  /** Names the kind's documents, tasks, request IDs, and message origin. Stored data depends on it: never rename. */
  kind: string;
  toolName: string;
  label: string;
  /** Shared by every job of every bot in this process. */
  answerListeners: Set<(answer: JobAnswer) => void>;
  Marker: JobMarkerDoc;
  Jobs: JobsDoc;
  Request: JobRequestDoc;
  Anchor: JobAnchor;
};

type JobKindState = JobKindBase & { Reporter: JobReporter };

/** The kind's documents: which conversations are its jobs, and the jobs of each chat. */
const jobDocuments = (kind: string) => ({
  /** Marks a conversation as a job of this kind; its environment is the bot's workspace. */
  Marker: defineDoc<{ job: boolean }>({
    kind: `crumble.${kind}-job`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ job: false }),
    checkpointWhen: () => false,
  }),

  Jobs: defineDoc<JobsState>({
    kind: `crumble.${kind}-jobs`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ jobs: {} }),
    // Every job's status change is a delta; a periodic full value bounds the replay on open.
    checkpointWhen: (_value, _ops, { deltasSinceBase }) =>
      deltasSinceBase >= 32,
  }),

  /** What a job was asked, on the job's conversation: read by its tools, such as a desktop job's intent check. */
  Request: defineDoc<JobRequest>({
    kind: `crumble.${kind}-job-request`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ ownerMessages: [], tasks: [] }),
    checkpointWhen: (_value, _ops, { deltasSinceBase }) =>
      deltasSinceBase >= 16,
  }),
});

// A delivery is stopped when its job is gone or was stopped after the delivery was queued.
// A delivery whose job was stopped since it was queued is settled here, so it no longer keeps the job busy.
const deliveryTarget = async (
  Jobs: JobsDoc,
  tx: Tx,
  chatId: ConversationId,
  reporter: ReporterTask<"wait" | "deliver">,
) => {
  const { name, stops = 0 } = reporter.input;
  const state = await tx.doc(Jobs, chatId);
  const job = state.jobs[name];

  if (job && (job.stops ?? 0) === stops)
    return { state, job, stopped: false as const };

  settleDelivery(job, reporter.id);

  return { state, job, stopped: true as const };
};

// Drops a delivery whose job was stopped since, and for an exclusive kind takes the screen in the same commit, so two
// waiting deliveries cannot both pass. A restart re-enters this phase and waits again.
const jobReporterWait =
  (kindState: JobKindBase) =>
  async (
    reporter: ReporterTask<"wait">,
    runtime: ReporterRuntime,
    taskContext: Context,
  ): Promise<void> => {
    const { name } = reporter.input;

    for (;;) {
      let waiting = false;

      await runtime.commit(async (tx) => {
        const { state, stopped } = await deliveryTarget(
          kindState.Jobs,
          tx,
          runtime.conversationId,
          reporter,
        );

        if (stopped)
          return {
            status: "terminal",
            outcome: { status: "completed", result: null },
          };

        if (kindState.options.exclusive) {
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
  };

// Admission checks the stop count and marks the delivery as submitting in one commit; stop waits for submitting
// deliveries before it aborts. So work is either never submitted, or submitted before the abort that cancels it.
const admitDelivery = async (
  kindState: JobKindBase,
  reporter: ReporterTask<"deliver">,
  runtime: ReporterRuntime,
  taskContext: Context,
): Promise<boolean> => {
  const { name } = reporter.input;
  let admitted = false;

  await runtime.commit(async (tx) => {
    const { state, job, stopped } = await deliveryTarget(
      kindState.Jobs,
      tx,
      runtime.conversationId,
      reporter,
    );

    if (stopped) {
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

  return admitted;
};

/** The report a settled delivery turns into; unset when the job has nothing to report. */
const deliveryReport = async (
  kindState: JobKindBase,
  tx: Tx,
  state: JobsState,
  name: string,
  settled: SettledSubmissionRecord,
): Promise<string | undefined> => {
  // Aborted means stopped or withdrawn: nothing to report.
  if (settled.status === "unanswered")
    return settled.reason === "aborted"
      ? undefined
      : `[${kindState.label} ${name} failed: ${settled.reason}]`;

  if (settled.type !== "input") return undefined;
  const job = state.jobs[name];

  if (!job || job.reported.includes(settled.answer)) return undefined;
  job.reported.push(settled.answer);

  const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];

  return `[${kindState.label} ${name} finished] ${answer?.role === "assistant" ? textOf(answer) : ""}`;
};

/** Submits the admitted message to the job, then commits the report its settlement became. */
const submitAndReport = async (
  kindState: JobKindBase,
  reporter: ReporterTask<"deliver">,
  runtime: ReporterRuntime,
  taskContext: Context,
): Promise<void> => {
  const { name, conversationId, message, followUp } = reporter.input;

  const job = (await runtime.conversation(conversationId, taskContext))!;

  const submission = await job.submit(
    {
      type: "input",
      content: message,
      whenBusy: followUp ? "followUp" : "steer",
      requestId: `${kindState.kind}:${reporter.id}`,
    },
    taskContext,
  );

  await runtime.commit(async (tx) => {
    settleDelivery(
      (await tx.doc(kindState.Jobs, runtime.conversationId)).jobs[name],
      reporter.id,
    );
  }, taskContext);

  const settled = await submission.wait(taskContext);

  await runtime.commit(async (tx) => {
    const state = await tx.doc(kindState.Jobs, runtime.conversationId);

    // The answer frees the screen for the next job, whether it reports or not.
    releaseHolder(state, name);

    return {
      status: "running",
      checkpoint: {
        phase: "report",
        report: await deliveryReport(kindState, tx, state, name, settled),
      },
    };
  }, taskContext);
};

const jobReporterDeliver =
  (kindState: JobKindBase) =>
  async (
    reporter: ReporterTask<"deliver">,
    runtime: ReporterRuntime,
    taskContext: Context,
  ): Promise<void> => {
    if (!(await admitDelivery(kindState, reporter, runtime, taskContext)))
      return;

    await submitAndReport(kindState, reporter, runtime, taskContext);
  };

/** The bot's answer to the job's report, as the report phase measures it: what a notification would show. */
const announceCheckpoint = async (
  tx: Tx,
  settled: SettledSubmissionRecord,
): Promise<NextTaskState<ReporterState, null>> => {
  const done = {
    status: "terminal",
    outcome: { status: "completed", result: null },
  } as const;

  if (settled.status === "unanswered" || settled.type !== "input") return done;

  const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];

  const preview = answer?.role === "assistant" ? textOf(answer).trim() : "";

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
};

const jobReporterReport =
  (kindState: JobKindBase) =>
  async (
    reporter: ReporterTask<"report">,
    runtime: ReporterRuntime,
    taskContext: Context,
  ): Promise<void> => {
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
        requestId: `${kindState.kind}-report:${reporter.id}`,
        entry: {
          kind: "crumble.message",
          data: {
            text,
            origin: { kind: kindState.kind, name: reporter.input.name },
          },
        },
      },
      taskContext,
    );

    // The bot's answer to the report is what the owner is notified about, such as a job asking for them.
    const settled = await submission.wait(taskContext);

    await runtime.commit(
      async (tx) => announceCheckpoint(tx, settled),
      taskContext,
    );
  };

const jobReporterAnnounce =
  (kindState: JobKindBase) =>
  async (
    reporter: ReporterTask<"announce">,
    runtime: ReporterRuntime,
    taskContext: Context,
  ): Promise<void> => {
    const { entryId, preview } = reporter.state.checkpoint;
    const { agentId, name } = reporter.input;

    if (agentId)
      for (const listener of kindState.answerListeners)
        listener({
          agentId,
          kind: kindState.kind,
          name,
          entryId,
          preview,
          eventId: `${kindState.kind}-report:${reporter.id}`,
        });

    await runtime.commit(
      () => ({
        status: "terminal",
        outcome: { status: "completed", result: null },
      }),
      taskContext,
    );
  };

const jobReporterAbort =
  (kindState: JobKindBase) =>
  (
    reporter: RunningTask<ReporterInput, ReporterState, null>,
    runtime: ReporterRuntime,
    taskContext: Context,
  ) =>
    runtime.commit(async (tx) => {
      const state = await tx.doc(kindState.Jobs, runtime.conversationId);

      settleDelivery(state.jobs[reporter.input.name], reporter.id);

      // An aborted delivery that held the screen frees it.
      if (reporter.state.checkpoint.phase === "deliver")
        releaseHolder(state, reporter.input.name);

      return { status: "terminal", outcome: { status: "aborted" } };
    }, taskContext);

// Delivers one message to a job and reports its answer to the bot. Request IDs keep a restart from delivering the
// message or the report twice.
const defineJobReporter = (kindState: JobKindBase): JobReporter =>
  defineTask<ReporterInput, ReporterState, null>({
    name: `crumble.${kindState.kind}-reporter`,
    version: 1,
    initial: () => ({ phase: "wait" }),
    phases: {
      wait: jobReporterWait(kindState),
      deliver: jobReporterDeliver(kindState),
      report: jobReporterReport(kindState),
      announce: jobReporterAnnounce(kindState),
    },
    abort: jobReporterAbort(kindState),
  });

/** Starts the job's own conversation as a copy of the bot's agent; false when the name is taken. */
const startJob = async (
  kindState: JobKindBase,
  tx: Tx,
  request: StartOrSend,
  state: JobsState,
) => {
  const { name, job, model } = request;

  if (Object.hasOwn(state.jobs, name)) return false;

  const anchor = await tx.createTask(kindState.Anchor, null, BACKGROUND);

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
    instructions: kindState.options.instructions,
    cwd: WORKSPACE_PATH,
    ...(model && { model }),
  });
  (await tx.doc(kindState.Marker, child.id)).job = true;
  state.jobs[name] = { conversationId: child.id, reported: [] };

  return true;
};

/** Whether a delivery of the job is submitting right now, which an abort must wait for. */
const submitting = async (
  kindState: JobKindBase,
  api: ToolExecutionApi,
  context: Context,
  name: string,
) =>
  Object.values(
    (await api.snapshot(kindState.Jobs, api.conversationId, context))?.jobs[
      name
    ]?.deliveries ?? {},
  ).includes("submitting");

/** Drops deliveries still waiting for the screen, then aborts the job's current answer and tools and its queued
 * messages. It stays usable. */
const stopJob = async (
  kindState: JobKindBase,
  call: JobToolCall,
  existing: Job,
  name: string,
) => {
  const { api, context, reply } = call;

  await api.commit(async (tx) => {
    const job = (await tx.doc(kindState.Jobs, api.conversationId)).jobs[name];

    if (job) job.stops = (job.stops ?? 0) + 1;
  }, context);

  // A delivery admitted before the stop count changed finishes submitting first, so the abort covers it.
  for (
    let waited = 0;
    waited < STOP_WAIT_MS && (await submitting(kindState, api, context, name));
    waited += STOP_POLL_MS
  )
    await awaitWithContext(
      new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS)),
      context,
    );

  await (await api.conversation(existing.conversationId, context))!.abort(
    context,
  );

  return reply(`Stopped ${name}.`);
};

/** Starts a job or messages an existing one, admitting its delivery before it answers. */
const startOrSend = async (
  kindState: JobKindState,
  call: JobToolCall,
  request: StartOrSend,
): Promise<Started> => {
  const { agentId, api, context } = call;

  return api.commit(async (tx): Promise<Started> => {
    const state = await tx.doc(kindState.Jobs, api.conversationId);
    let attached: OwnerMessage[] = [];

    if (kindState.options.ownerRequest) {
      const cited = await ownerMessages(
        tx,
        api.conversationId,
        request.ownerMessages,
      );

      if ("unknown" in cited)
        return {
          text: `Not owner messages of this chat: ${cited.unknown.join(", ")}. Cite the request IDs shown as [message ID].`,
          found: undefined,
        };
      attached = cited.messages;
    }

    if (
      request.action === "start" &&
      !(await startJob(kindState, tx, request, state))
    )
      return {
        text: `${request.name} already exists; use send.`,
        found: undefined,
      };

    const record = state.jobs[request.name]!;
    const conversationId = record.conversationId;

    if (kindState.options.ownerRequest)
      addToRequest(
        await tx.doc(kindState.Request, conversationId),
        { name: request.name, chatId: api.conversationId },
        attached,
        request.message,
      );

    const reporter = await tx.createTask(
      kindState.Reporter,
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
const statusReply = async (
  kindState: JobKindBase,
  call: JobToolCall,
  name: string | undefined,
) => {
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
    : `No ${kindState.label}s.`;

  return reply(text);
};

const jobCardName = (toolName: string, message: ToolResultMessage) => {
  if (
    message.role !== "toolResult" ||
    message.toolName !== toolName ||
    message.isError
  )
    return undefined;

  return jobCard.safeParse(message.toolDetails).data?.name;
};

/** The jobs of a bot's chat, oldest first: conversation IDs only grow, whereas record keys reorder numeric names. */
const listedJobs = async (
  kindState: JobKindBase,
  harness: Harness,
  chatId: ConversationId,
): Promise<ListedJob[]> => {
  const jobs =
    (await harness.snapshot(kindState.Jobs, chatId, BACKGROUND_CONTEXT))
      ?.jobs ?? {};

  const found = await Promise.all(
    Object.entries(jobs).map(async ([name, job]) => {
      const listed: ListedJob = {
        name,
        conversationId: job.conversationId,
        status: await statusOf(harness, job, BACKGROUND_CONTEXT),
      };

      const [agent, usage] = await Promise.all([
        harness.snapshot(AgentDoc, job.conversationId, BACKGROUND_CONTEXT),
        harness.snapshot(UsageDoc, job.conversationId, BACKGROUND_CONTEXT),
      ]);

      return {
        ...listed,
        ...(agent?.model && {
          model: {
            provider: agent.model.provider,
            model: agent.model.modelId,
          },
        }),
        ...(usage && { usage }),
      };
    }),
  );

  return found.sort(
    (a, b) => Number(a.conversationId) - Number(b.conversationId),
  );
};

const isJobConversation = async (
  kindState: JobKindBase,
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
) =>
  (await reader.snapshot(kindState.Marker, conversationId, context))?.job ===
  true;

/**
 * A job's environment is its bot's workspace. Any other conversation, such as the bot's chat, gets none, so a
 * tool that wrongly reached for a shell would fail instead of touching the workspace.
 */
const jobEnv = async (
  kindState: JobKindBase,
  workspaces: Workspaces,
  agentId: string,
  target: EnvTarget,
  context: Context,
  shellEnv?: Record<string, string>,
): Promise<ExecutionEnv | undefined> => {
  const marker = await target.read.snapshot(
    kindState.Marker,
    target.conversationId,
    context,
  );

  return marker?.job ? workspaces.env(agentId, shellEnv) : undefined;
};

const jobParameters = {
  action: Type.Union([
    Type.Literal("start"),
    Type.Literal("send"),
    Type.Literal("stop"),
    Type.Literal("status"),
  ]),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  message: Type.Optional(Type.String({ minLength: 1, maxLength: 32000 })),
  followUp: Type.Optional(Type.Boolean()),
};

const ownerRequestParameters = Type.Object({
  ...jobParameters,
  owner_messages: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 50,
      description:
        "start and send: request IDs of the owner messages in this chat the job concerns, shown as [message ID]. The owner's latest message is always attached.",
    }),
  ),
});

const jobTool = (kindState: JobKindState, input: JobToolInput) =>
  defineTool({
    name: kindState.toolName,
    description: kindState.options.description,
    parameters: kindState.options.ownerRequest
      ? ownerRequestParameters
      : Type.Object(jobParameters),
    callers: ["model"],
    // A rerun of stop or send after a crash could hit newer work; the model can check with status.
    replay: "unsafe",
    execute: (args, api, callContext) =>
      runJobTool(kindState, input, args, api, callContext),
  });

/** Runs one call of the job tool: status, start, send, or stop, and the reply the model reads. */
const runJobTool = async (
  kindState: JobKindState,
  input: JobToolInput,
  args: JobToolArgs,
  api: ToolExecutionApi,
  callContext: Context,
): Promise<ToolExecutionResult<JobDetails>> => {
  const { action, name, message } = args;

  const jobs =
    (await api.snapshot(kindState.Jobs, api.conversationId, callContext))
      ?.jobs ?? {};

  const call: JobToolCall = {
    agentId: input.agentId,
    api,
    context: callContext,
    jobs,
    reply: (text, found) => jobReply(input.agentId, text, found),
  };

  if (action === "status") return statusReply(kindState, call, name);

  if (name === undefined) return call.reply(`${action} needs a name.`);
  const existing = Object.hasOwn(jobs, name) ? jobs[name] : undefined;

  if (action !== "start" && !existing)
    return call.reply(`No ${kindState.label} named ${name}.`);

  if (action === "stop") return stopJob(kindState, call, existing!, name);

  if (message === undefined) return call.reply(`${action} needs a message.`);

  const result = await startOrSend(kindState, call, {
    action,
    name,
    message,
    followUp: args.followUp === true,
    ownerMessages: args.owner_messages ?? [],
    job: input.job,
    model: input.model,
  });

  // Only a start shows the job's card, once per job; the turn ends with it, as after `show`.
  return action === "start" && result.found
    ? {
        ...call.reply(result.text, result.found),
        control: { terminate: true },
      }
    : call.reply(result.text);
};

const jobExtensions = (
  kindState: JobKindState,
  input: JobToolInput,
): JobExtensions => {
  const chat = defineExtension({
    name: kindState.toolName,
    tools: [jobTool(kindState, input)],
    tasks: [kindState.Anchor, kindState.Reporter],
  });

  return { chat: [chat], job: [input.job] };
};

/** The job kind's public surface: its answers, its jobs, and the extensions a bot runs it with. */
const jobKindApi = (state: JobKindState) => {
  const { toolName } = state;

  return {
    toolName,

    /** Hears the bot's answer to each report of a job of this kind, from every bot in this process. */
    onAnswer: (listener: (answer: JobAnswer) => void) => {
      state.answerListeners.add(listener);

      return () => void state.answerListeners.delete(listener);
    },

    /** The job a start shows as a card; other actions and failed calls show none. */
    jobOf: (message: ToolResultMessage): string | undefined =>
      jobCardName(toolName, message),

    /** The jobs of a bot's chat, oldest first: conversation IDs only grow, whereas record keys reorder numeric names. */
    list: (harness: Harness, chatId: ConversationId) =>
      listedJobs(state, harness, chatId),

    /** What the job was asked: its owner messages and tasks. Empty for a kind without `ownerRequest`. */
    request: async (
      reader: DocumentReader,
      conversationId: ConversationId,
      context: Context,
    ): Promise<JobRequest> =>
      (await reader.snapshot(state.Request, conversationId, context)) ?? {
        ownerMessages: [],
        tasks: [],
      },

    /** Whether the conversation is a job of this kind. */
    isJob: (
      reader: DocumentReader,
      conversationId: ConversationId,
      context: Context,
    ) => isJobConversation(state, reader, conversationId, context),

    /**
     * A job's environment is its bot's workspace. Any other conversation, such as the bot's chat, gets none, so a
     * tool that wrongly reached for a shell would fail instead of touching the workspace.
     */
    env: (
      workspaces: Workspaces,
      agentId: string,
      target: EnvTarget,
      context: Context,
      shellEnv?: Record<string, string>,
    ): Promise<ExecutionEnv | undefined> =>
      jobEnv(state, workspaces, agentId, target, context, shellEnv),

    extensions: (input: JobToolInput): JobExtensions =>
      jobExtensions(state, input),
  };
};

/** Creates the kind's documents, anchor task, and answer listeners once. */
const jobKindBase = (options: JobKindOptions): JobKindBase => {
  const { kind, toolName, label } = options;

  return {
    options,
    kind,
    toolName,
    label,
    answerListeners: new Set<(answer: JobAnswer) => void>(),
    ...jobDocuments(kind),
    // The job's conversation is owned by this task so it outlives the bot's turns and Esc.
    Anchor: defineAnchorTask(`crumble.${kind}-anchor`),
  };
};

const jobKindState = (options: JobKindOptions): JobKindState => {
  const base = jobKindBase(options);

  return { ...base, Reporter: defineJobReporter(base) };
};

export type JobKind = ReturnType<typeof defineJobKind>;

/** Background jobs a bot hands work to: child conversations of its chat, built on Pi Durable's background subagent pattern. */
export function defineJobKind(options: JobKindOptions) {
  return jobKindApi(jobKindState(options));
}
