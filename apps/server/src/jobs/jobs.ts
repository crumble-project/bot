import { chatOnly } from "../shared/chat-only";
import { JOB_QUESTION_ENTRY, MESSAGE_ENTRY } from "../transcript/entries";
import { sleep } from "../shared/time";
import { jobDeliveryRequest, jobReportRequest } from "../shared/request-ids";
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT,
  awaitWithContext,
} from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
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
import { formatEntryId } from "../shared/entry-ids";
import { replyText } from "../shared/reply-text";
import { defineAnchorTask } from "../shared/anchor-task";
import { WORKSPACE_PATH } from "../../workspace-image/guest";
import type { Workspaces } from "../workspaces/workspace";
import {
  addToRequest,
  ownerMessages,
  type JobRequest,
  type OwnerMessage,
} from "./owner-request";
import { chatExcerpt } from "./chat-excerpt";
import type { JobKindFacts } from "../shared/job-kinds";
import { ASK_OWNER_TOOL_NAME } from "../contract/tools";
import { MAX_MESSAGE_CHARS, MESSAGE_PREVIEW_CHARS } from "../shared/limits";

export const JOB_KNOWLEDGE_EXTENSION = "job-knowledge";

export const modelRef = (source: { provider: string; model: string }) => ({
  provider: source.provider,
  modelId: source.model,
});

export type JobInfo = {
  name: string;
  conversationId: ConversationId;
  status: "working" | "idle";
};

export type JobQuestion = {
  id: string;
  text: string;
  askedAt: number;
  options?: string[];
  multiple?: boolean;
};

export type JobAsked = {
  agentId: string;
  kind: string;
  label: string;
  name: string;
  question: JobQuestion;
  turn: string[];
};

export type TurnWork = {
  open: boolean;
  reports: string[];
  error?: string;
};

export type ListedJob = JobInfo & {
  model?: { provider: string; model: string };
  usage?: UsageState;
  question?: JobQuestion;
};

export type JobExtensions = {
  chat: Extension[];
  job: Extension[];
};

type Job = {
  conversationId: ConversationId;
  reported: EntryId[];
  stops: number;
  /**
   * Deliveries not yet admitted to the job, by reporter task ID: waiting for their turn, or submitting right now. A job
   * with any counts as working, and stop waits for submitting ones so its abort covers their work.
   */
  deliveries?: Record<string, "waiting" | "submitting">;
};

type Holder = { name: string; deliveries: number };

type TurnDeliveries = {
  open: string[];
  reports: string[];
  error?: string;
};

type JobsState = {
  jobs: Record<string, Job>;
  holder?: Holder;
  turns?: Record<string, TurnDeliveries>;
};

export type JobAnswer = {
  agentId: string;
  kind: string;
  name: string;
  entryId: string;
  preview: string;
  /** Stable per report, so a repeated announcement can be recognized. */
  eventId: string;
};

export type JobFinished = {
  agentId: string;
  kind: string;
  name: string;
  conversationId: ConversationId;
  submissionId: string;
};

type ReporterInput = {
  agentId: string;
  name: string;
  conversationId: ConversationId;
  message: string;
  followUp: boolean;
  stops: number;
  turn?: string;
};

type JobReport = { frame: string; text?: string };

type ReporterState =
  | { phase: "wait" }
  | { phase: "deliver" }
  | {
      phase: "report";
      report?: JobReport | undefined;
      error?: string;
      asked?: JobAsked;
    }
  | { phase: "announce"; entryId: string; preview: string };

const WAIT_MS = 1000;
const STOP_POLL_MS = 50;

// A delivery that crashed while submitting stays marked; stop aborts after this long anyway.
const STOP_WAIT_MS = 10_000;

const COMPLETED = {
  status: "terminal",
  outcome: { status: "completed", result: null },
} as const;

const releaseHolder = (state: JobsState, name: string) => {
  if (state.holder?.name !== name) return;
  state.holder.deliveries -= 1;

  if (state.holder.deliveries <= 0) delete state.holder;
};

const settleDelivery = (job: Job | undefined, reporterId: TaskId<null>) => {
  if (job?.deliveries) delete job.deliveries[String(reporterId)];
};

const KEPT_TURNS = 200;

const pruneTurns = (turns: Record<string, TurnDeliveries>) => {
  const settled = Object.keys(turns)
    .filter((key) => turns[key]!.open.length === 0)
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

  for (const key of settled.slice(0, Math.max(0, settled.length - KEPT_TURNS)))
    delete turns[key];
};

const openTurnWork = (
  state: JobsState,
  turn: string | undefined,
  reporterId: string,
  replaces?: string,
) => {
  if (turn === undefined) return;
  state.turns ??= {};
  const work = state.turns[turn];

  if (!work) {
    pruneTurns(state.turns);
    state.turns[turn] = { open: [reporterId], reports: [] };

    return;
  }

  work.open = [...work.open.filter((id) => id !== replaces), reporterId];
};

const closeTurnWork = (
  state: JobsState,
  turn: string | undefined,
  reporterId: string,
  error?: string,
) => {
  const work = turn === undefined ? undefined : state.turns?.[turn];

  if (!work?.open.includes(reporterId)) return;
  work.open = work.open.filter((id) => id !== reporterId);

  if (error && !work.error) work.error = error;
};

const stoppedError = (kindState: JobKindBase, name: string) =>
  `${kindState.label} ${name} was stopped`;

const statusOf = async (reader: DocumentReader, job: Job, context: Context) =>
  Object.keys(job.deliveries ?? {}).length > 0 ||
  (await reader.snapshot(LiveDoc, job.conversationId, context))?.run
    ? ("working" as const)
    : ("idle" as const);

type JobDetails = {
  name: string;
  status: JobInfo["status"];
  conversationId: string;
};

type Reply = (text: string, found?: JobInfo) => ToolExecutionResult<JobDetails>;

type JobToolCall = {
  agentId: string;
  api: ToolExecutionApi;
  context: Context;
  jobs: JobsState["jobs"];
  reply: Reply;
};

type StartOrSend = {
  action: "start" | "send";
  name: string;
  message: string;
  followUp: boolean;
  ownerMessages: string[];
  job: Extension;
  instructions: string;
  model: ModelRef | undefined;
  knowledge: Extension | undefined;
  turn: string | undefined;
};

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
      conversationId: formatEntryId(agentId, Number(found.conversationId)),
    },
  };
}

type JobMarkerDoc = ConversationDocToken<{ job: boolean }>;

type JobsDoc = ConversationDocToken<JobsState>;

type JobRequestDoc = ConversationDocToken<JobRequest>;

type JobAnchor = Task<null, { phase: "done" }, null, object>;

type JobReporter = Task<ReporterInput, ReporterState, null, object>;

type ReporterRuntime = TaskRuntime<ReporterInput, ReporterState, null, object>;

type ReporterTask<P extends ReporterState["phase"]> = RunningTask<
  ReporterInput,
  Extract<ReporterState, { phase: P }>,
  null
>;

type JobToolInput = {
  agentId: string;
  job: Extension;
  description: string;
  instructions: string;
  model?: ModelRef;
};

type JobToolArgs = {
  action: "start" | "send" | "stop" | "status";
  name?: string;
  message?: string;
  followUp?: boolean;
  owner_messages?: string[];
};

type PendingQuestion = JobQuestion & {
  posted?: boolean;
  turn?: string;
  reporter?: string;
};

type QuestionDoc = ConversationDocToken<{ pending: PendingQuestion | null }>;

type JobKindBase = JobKindFacts & {
  answerListeners: Set<(answer: JobAnswer) => void>;
  finishedListeners: Set<(finished: JobFinished) => void>;
  questionListeners: Set<(asked: JobAsked) => Promise<void>>;
  Marker: JobMarkerDoc;
  Jobs: JobsDoc;
  Request: JobRequestDoc;
  Question: QuestionDoc;
  Anchor: JobAnchor;
};

type JobKindState = JobKindBase & { Reporter: JobReporter };

const jobDocuments = (kind: string) => ({
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

  Question: defineDoc<{ pending: PendingQuestion | null }>({
    kind: `crumble.${kind}-job-question`,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: () => ({ pending: null }),
    checkpointWhen: () => true,
  }),
});

const deliveryTarget = async (
  Jobs: JobsDoc,
  tx: Tx,
  chatId: ConversationId,
  reporter: ReporterTask<"wait" | "deliver">,
) => {
  const { name, stops } = reporter.input;
  const state = await tx.doc(Jobs, chatId);
  const job = state.jobs[name];

  if (job && job.stops === stops)
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

        if (stopped) {
          closeTurnWork(
            state,
            reporter.input.turn,
            String(reporter.id),
            stoppedError(kindState, name),
          );

          return COMPLETED;
        }

        if (kindState.exclusive) {
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

      await awaitWithContext(sleep(WAIT_MS), taskContext);
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

      return {
        status: "running",
        checkpoint: { phase: "report", error: stoppedError(kindState, name) },
      };
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

const deliveryReport = async (
  kindState: JobKindBase,
  tx: Tx,
  state: JobsState,
  name: string,
  settled: SettledSubmissionRecord,
): Promise<JobReport | undefined> => {
  if (settled.status === "unanswered")
    return settled.reason === "aborted"
      ? undefined
      : { frame: `[${kindState.label} ${name} failed: ${settled.reason}]` };

  if (settled.type !== "input") return undefined;
  const job = state.jobs[name];

  if (!job || job.reported.includes(settled.answer)) return undefined;
  job.reported.push(settled.answer);

  const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];

  return {
    frame: `[${kindState.label} ${name} finished]`,
    text: answer?.role === "assistant" ? replyText(answer) : "",
  };
};

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
      requestId: jobDeliveryRequest(kindState.kind, reporter.id),
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
  let reported = false;

  await runtime.commit(async (tx) => {
    const state = await tx.doc(kindState.Jobs, runtime.conversationId);

    releaseHolder(state, name);

    const asked = await postQuestion(
      kindState,
      tx,
      runtime.conversationId,
      reporter,
    );

    const report = asked
      ? undefined
      : await deliveryReport(kindState, tx, state, name, settled);

    reported = report !== undefined && settled.status !== "unanswered";
    const error = asked ? undefined : deliveryError(kindState, name, settled);

    return {
      status: "running",
      checkpoint: {
        phase: "report",
        report,
        ...(error && { error }),
        ...(asked && { asked }),
      },
    };
  }, taskContext);

  const { agentId } = reporter.input;

  // After the commit, so a review never reads a turn that a crash would deliver again.
  if (reported)
    for (const listener of kindState.finishedListeners)
      listener({
        agentId,
        kind: kindState.kind,
        name,
        conversationId,
        submissionId: String(settled.id),
      });
};

const deliveryError = (
  kindState: JobKindBase,
  name: string,
  settled: SettledSubmissionRecord,
) => {
  if (settled.status !== "unanswered") return undefined;

  return settled.reason === "aborted"
    ? stoppedError(kindState, name)
    : `${kindState.label} ${name} failed: ${settled.reason}`;
};

const askedQuestion = ({
  id,
  text,
  askedAt,
  options,
  multiple,
}: PendingQuestion): JobQuestion => ({
  id,
  text,
  askedAt,
  ...(options && { options }),
  ...(multiple && { multiple: true }),
});

const postQuestion = async (
  kindState: JobKindBase,
  tx: Tx,
  chatId: ConversationId,
  reporter: ReporterTask<"deliver">,
): Promise<JobAsked | undefined> => {
  const { agentId, name, conversationId, turn } = reporter.input;
  const question = await tx.doc(kindState.Question, conversationId);
  const pending = question.pending;

  if (!pending || pending.posted) return undefined;
  question.pending = {
    ...pending,
    posted: true,
    ...(turn !== undefined && { turn, reporter: String(reporter.id) }),
  };
  await tx.appendEntry(chatId, {
    kind: JOB_QUESTION_ENTRY,
    data: {
      ...askedQuestion(pending),
      kind: kindState.kind,
      job: name,
      timestamp: pending.askedAt,
    },
  });

  return {
    agentId,
    kind: kindState.kind,
    label: kindState.label,
    name,
    question: askedQuestion(pending),
    turn: turn?.split(",") ?? [],
  };
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

const announceCheckpoint = async (
  tx: Tx,
  settled: SettledSubmissionRecord,
): Promise<NextTaskState<ReporterState, null>> => {
  if (settled.status === "unanswered" || settled.type !== "input")
    return COMPLETED;

  const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0];

  const preview = answer?.role === "assistant" ? replyText(answer).trim() : "";

  if (!preview) return COMPLETED;

  return {
    status: "running",
    checkpoint: {
      phase: "announce",
      entryId: String(settled.answer),
      preview: preview.slice(0, MESSAGE_PREVIEW_CHARS),
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
    const { report, error, asked } = reporter.state.checkpoint;
    const { turn } = reporter.input;
    const id = String(reporter.id);

    // A rerun after a restart asks again; listeners recognize the question by its ID.
    if (asked?.turn.length)
      await Promise.allSettled(
        [...kindState.questionListeners].map((listener) => listener(asked)),
      );

    if (report === undefined)
      return runtime.commit(async (tx) => {
        if (!asked)
          closeTurnWork(
            await tx.doc(kindState.Jobs, runtime.conversationId),
            turn,
            id,
            error,
          );

        return COMPLETED;
      }, taskContext);

    const chat = (await runtime.conversation(
      runtime.conversationId,
      taskContext,
    ))!;

    const submission = await chat.submit(
      {
        type: "input",
        content:
          report.text === undefined
            ? report.frame
            : `${report.frame} ${report.text}`,
        whenBusy: "followUp",
        requestId: jobReportRequest(kindState.kind, reporter.id),
        entry: {
          kind: MESSAGE_ENTRY,
          data: {
            text: report.text ?? "",
            origin: { kind: kindState.kind, name: reporter.input.name },
          },
        },
      },
      taskContext,
    );

    if (turn !== undefined)
      await runtime.commit(async (tx) => {
        const work = (await tx.doc(kindState.Jobs, runtime.conversationId))
          .turns?.[turn];

        if (work && !work.reports.includes(String(submission.id)))
          work.reports.push(String(submission.id));
      }, taskContext);

    const settled = await submission.wait(taskContext);

    await runtime.commit(async (tx) => {
      closeTurnWork(
        await tx.doc(kindState.Jobs, runtime.conversationId),
        turn,
        id,
        error,
      );

      return announceCheckpoint(tx, settled);
    }, taskContext);
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

    for (const listener of kindState.answerListeners)
      listener({
        agentId,
        kind: kindState.kind,
        name,
        entryId,
        preview,
        eventId: jobReportRequest(kindState.kind, reporter.id),
      });

    await runtime.commit(() => COMPLETED, taskContext);
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
      closeTurnWork(
        state,
        reporter.input.turn,
        String(reporter.id),
        stoppedError(kindState, reporter.input.name),
      );

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

const jobInstructions = (instructions: string, chat: string) =>
  chat
    ? `${instructions}\n\nThe bot's chat with its owner when it started you, latest message last. The bot's message to you is your task; this is its background:\n<recent_chat>\n${chat}\n</recent_chat>`
    : instructions;

const startJob = async (
  kindState: JobKindBase,
  tx: Tx,
  request: StartOrSend,
  state: JobsState,
  chat: string,
) => {
  const { name, job, instructions, model, knowledge } = request;

  if (Object.hasOwn(state.jobs, name)) return false;

  const anchor = await tx.createTask(kindState.Anchor, null, BACKGROUND);

  // Starts as a copy of the bot's agent, then keeps only the job's own tools and the bot's knowledge. Selecting exactly
  // these drops the bot's other tools, hooks, and prompt sections, so a job can neither start jobs nor delegate,
  // schedule, write memory, or reach integrations.
  const child = await tx.createConversation({
    ownership: { kind: "task", taskId: anchor },
  });

  await configure(tx, child.id, {
    extensions: knowledge ? [job, knowledge] : [job],
    tools: null,
    modelTools: null,
    instructions: jobInstructions(instructions, chat),
    cwd: WORKSPACE_PATH,
    ...(model && { model }),
  });
  (await tx.doc(kindState.Marker, child.id)).job = true;
  state.jobs[name] = { conversationId: child.id, reported: [], stops: 0 };

  return true;
};

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

const stopJob = async (
  kindState: JobKindBase,
  call: JobToolCall,
  existing: Job,
  name: string,
) => {
  const { api, context, reply } = call;

  await api.commit(async (tx) => {
    const job = (await tx.doc(kindState.Jobs, api.conversationId)).jobs[name];

    if (job) job.stops += 1;
  }, context);

  // A delivery admitted before the stop count changed finishes submitting first, so the abort covers it.
  for (
    let waited = 0;
    waited < STOP_WAIT_MS && (await submitting(kindState, api, context, name));
    waited += STOP_POLL_MS
  )
    await awaitWithContext(sleep(STOP_POLL_MS), context);

  await (await api.conversation(existing.conversationId, context))!.abort(
    context,
  );

  return reply(`Stopped ${name}.`);
};

const queueDelivery = async (
  kindState: JobKindState,
  tx: Tx,
  state: JobsState,
  record: Job,
  input: ReporterInput,
  answering?: { chatId: ConversationId; replaces: string | undefined },
) => {
  const reporter = await tx.createTask(
    kindState.Reporter,
    input,
    answering === undefined
      ? BACKGROUND
      : { ...BACKGROUND, conversationId: answering.chatId },
  );

  record.deliveries = {
    ...record.deliveries,
    [String(reporter)]: "waiting",
  };
  openTurnWork(state, input.turn, String(reporter), answering?.replaces);
};

const turnOf = async (api: ToolExecutionApi, context: Context) => {
  const inputs =
    (await api.snapshot(LiveDoc, api.conversationId, context))?.run?.inputs ??
    [];

  return inputs.length ? inputs.map(String).join(",") : undefined;
};

/** The chat excerpt a new job starts with. Read before the start writes anything: a commit's table reads come first. */
const startExcerpt = (
  tx: Tx,
  chatId: ConversationId,
  request: StartOrSend,
  state: JobsState,
) =>
  request.action === "start" && !Object.hasOwn(state.jobs, request.name)
    ? chatExcerpt(tx, chatId)
    : Promise.resolve("");

const startOrSend = async (
  kindState: JobKindState,
  call: JobToolCall,
  request: StartOrSend,
): Promise<Started> => {
  const { agentId, api, context } = call;

  return api.commit(async (tx): Promise<Started> => {
    const state = await tx.doc(kindState.Jobs, api.conversationId);
    let attached: OwnerMessage[] = [];

    if (kindState.ownerRequest) {
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

    const chat = await startExcerpt(tx, api.conversationId, request, state);

    if (
      request.action === "start" &&
      !(await startJob(kindState, tx, request, state, chat))
    )
      return {
        text: `${request.name} already exists; use send.`,
        found: undefined,
      };

    const record = state.jobs[request.name]!;
    const conversationId = record.conversationId;

    if (kindState.ownerRequest)
      addToRequest(
        await tx.doc(kindState.Request, conversationId),
        { name: request.name, chatId: api.conversationId },
        attached,
        request.message,
      );

    const question = await tx.doc(kindState.Question, conversationId);

    if (question.pending?.reporter)
      closeTurnWork(state, question.pending.turn, question.pending.reporter);
    question.pending = null;
    await queueDelivery(kindState, tx, state, record, {
      agentId,
      name: request.name,
      conversationId,
      message: request.message,
      followUp: request.action === "send" && request.followUp,
      stops: record.stops,
      ...(request.turn !== undefined && { turn: request.turn }),
    });

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

  const asked = await Promise.all(
    found.map(async (each) =>
      openQuestion(kindState, api, each.conversationId, context),
    ),
  );

  const text = found.length
    ? found
        .map(
          (each, index) =>
            `${each.name}: ${each.status}${asked[index] ? ` (waiting for the owner's answer to: ${asked[index].text})` : ""}`,
        )
        .join("\n")
    : `No ${kindState.label}s.`;

  return reply(text);
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

      const [agent, usage, question] = await Promise.all([
        harness.snapshot(AgentDoc, job.conversationId, BACKGROUND_CONTEXT),
        harness.snapshot(UsageDoc, job.conversationId, BACKGROUND_CONTEXT),
        openQuestion(
          kindState,
          harness,
          job.conversationId,
          BACKGROUND_CONTEXT,
        ),
      ]);

      return {
        ...listed,
        ...(question && { question }),
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

const openQuestion = async (
  kindState: JobKindBase,
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
): Promise<JobQuestion | undefined> => {
  const pending = (
    await reader.snapshot(kindState.Question, conversationId, context)
  )?.pending;

  return pending?.posted ? askedQuestion(pending) : undefined;
};

const isJobConversation = async (
  kindState: JobKindBase,
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
) =>
  (await reader.snapshot(kindState.Marker, conversationId, context))?.job ===
  true;

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
  message: Type.Optional(
    Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS }),
  ),
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
    description: input.description,
    parameters: kindState.ownerRequest
      ? ownerRequestParameters
      : Type.Object(jobParameters),
    callers: ["model"],
    // A rerun of stop or send after a crash could hit newer work; the model can check with status.
    replay: "unsafe",
    execute: (args, api, callContext) =>
      runJobTool(kindState, input, args, api, callContext),
  });

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
    instructions: input.instructions,
    model: input.model,
    knowledge: api.registry.extension(JOB_KNOWLEDGE_EXTENSION),
    turn: await turnOf(api, callContext),
  });

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

  return {
    chat: [chatOnly(chat)],
    job: [input.job],
  };
};

const jobKindApi = (state: JobKindState) => {
  return {
    kind: state.kind,

    onAnswer: (listener: (answer: JobAnswer) => void) => {
      state.answerListeners.add(listener);

      return () => void state.answerListeners.delete(listener);
    },

    onFinished: (listener: (finished: JobFinished) => void) => {
      state.finishedListeners.add(listener);

      return () => void state.finishedListeners.delete(listener);
    },

    /** The jobs of a bot's chat, oldest first: conversation IDs only grow, whereas record keys reorder numeric names. */
    list: (harness: Harness, chatId: ConversationId) =>
      listedJobs(state, harness, chatId),

    request: async (
      reader: DocumentReader,
      conversationId: ConversationId,
      context: Context,
    ): Promise<JobRequest> =>
      (await reader.snapshot(state.Request, conversationId, context)) ?? {
        ownerMessages: [],
        tasks: [],
      },

    isJob: (
      reader: DocumentReader,
      conversationId: ConversationId,
      context: Context,
    ) => isJobConversation(state, reader, conversationId, context),

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

    questionTool: (onAsked?: (conversationId: ConversationId) => void) =>
      questionTool(state, onAsked),

    /**
     * Sends the answer of the owner or of the delegating bot to the job's open question, which resumes the job. False
     * when the job asked nothing or `questionId` names an older question.
     */
    answer: (
      harness: Harness,
      chatId: ConversationId,
      answer: JobQuestionAnswer,
    ) => answerQuestion(state, harness, chatId, answer),

    /**
     * Hears each question a job asks about work a bot turn sent it, once its card is in the chat; it may hear one again
     * after a restart. From all the bots of this definition.
     */
    onQuestion: (listener: (asked: JobAsked) => Promise<void>) => {
      state.questionListeners.add(listener);

      return () => void state.questionListeners.delete(listener);
    },

    turnWork: (
      harness: Harness,
      chatId: ConversationId,
      submissionId: string,
    ) => turnWork(state, harness, chatId, submissionId),
  };
};

const questionTool = (
  kindState: JobKindBase,
  onAsked: ((conversationId: ConversationId) => void) | undefined,
) =>
  defineTool({
    name: ASK_OWNER_TOOL_NAME,
    description:
      "Ask the owner a question and end your turn. Ask only when the answer changes what you build or a decision is theirs to make; otherwise decide yourself and proceed. When the answer is one of a few choices, list them as options: the owner picks one with a click or writes their own. When another bot delegated your task, that bot may answer first from its brief; the owner can still answer. The answer arrives as your next message.",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 4000 }),
      options: Type.Optional(
        Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
          minItems: 2,
          maxItems: 6,
          description:
            "Short, distinct answers, most likely first. Leave out a catch-all such as Other; the owner can always write their own.",
        }),
      ),
      multiple: Type.Optional(
        Type.Boolean({
          description:
            "true when several options can apply together; the answer then lists every one the owner picked.",
        }),
      ),
    }),
    callers: ["model"],
    replay: "unsafe",
    execute: async (args, api, context) => {
      await api.commit(async (tx) => {
        (await tx.doc(kindState.Question, api.conversationId)).pending = {
          id: crypto.randomUUID(),
          text: args.question,
          askedAt: api.now(),
          ...(args.options && { options: args.options }),
          ...(args.options && args.multiple && { multiple: true }),
        };
      }, context);
      onAsked?.(api.conversationId);

      return {
        output: [
          {
            type: "text" as const,
            text: "Asked the owner. End your turn now; the answer arrives as your next message.",
          },
        ],
        control: { terminate: true },
      };
    },
  });

export type JobQuestionAnswer = {
  agentId: string;
  name: string;
  questionId: string;
  text: string;
  by?: string;
};

const answerQuestion = (
  kindState: JobKindState,
  harness: Harness,
  chatId: ConversationId,
  answer: JobQuestionAnswer,
) =>
  harness.commit(async (tx) => {
    const state = await tx.doc(kindState.Jobs, chatId);
    const record = state.jobs[answer.name];

    if (!record) return false;
    const question = await tx.doc(kindState.Question, record.conversationId);
    const pending = question.pending;

    if (pending?.id !== answer.questionId) return false;
    question.pending = null;
    await queueDelivery(
      kindState,
      tx,
      state,
      record,
      {
        agentId: answer.agentId,
        name: answer.name,
        conversationId: record.conversationId,
        message: `${answer.by ?? "The owner"} answered your question: ${answer.text}`,
        followUp: false,
        stops: record.stops,
        ...(pending.turn !== undefined && { turn: pending.turn }),
      },
      { chatId, replaces: pending.reporter },
    );

    return true;
  }, BACKGROUND_CONTEXT);

export function mergeTurnWork(found: TurnWork[]): TurnWork | undefined {
  if (!found.length) return undefined;
  const error = found.find((work) => work.error)?.error;

  return {
    open: found.some((work) => work.open),
    reports: found.flatMap((work) => work.reports),
    ...(error && { error }),
  };
}

const turnWork = async (
  kindState: JobKindBase,
  reader: DocumentReader,
  chatId: ConversationId,
  submissionId: string,
): Promise<TurnWork | undefined> => {
  const turns =
    (await reader.snapshot(kindState.Jobs, chatId, BACKGROUND_CONTEXT))
      ?.turns ?? {};

  return mergeTurnWork(
    Object.entries(turns).flatMap(([key, work]) =>
      key.split(",").includes(submissionId)
        ? [{ ...work, open: work.open.length > 0 }]
        : [],
    ),
  );
};

const jobKindBase = (facts: JobKindFacts): JobKindBase => {
  const { kind } = facts;

  return {
    ...facts,
    answerListeners: new Set<(answer: JobAnswer) => void>(),
    finishedListeners: new Set<(finished: JobFinished) => void>(),
    questionListeners: new Set<(asked: JobAsked) => Promise<void>>(),
    ...jobDocuments(kind),
    // The job's conversation is owned by this task so it outlives the bot's turns and Esc.
    Anchor: defineAnchorTask(`crumble.${kind}-anchor`),
  };
};

const jobKindState = (facts: JobKindFacts): JobKindState => {
  const base = jobKindBase(facts);

  return { ...base, Reporter: defineJobReporter(base) };
};

export type JobKind = ReturnType<typeof defineJobKind>;

/**
 * Background jobs a bot hands work to: child conversations of its chat, built on Pi Durable's background subagent
 * pattern. Documents and tasks are named by the facts alone, so any definition reads a kind's jobs, while listeners
 * hear only the jobs of the definition whose extensions run them.
 */
export function defineJobKind(facts: JobKindFacts) {
  return jobKindApi(jobKindState(facts));
}
