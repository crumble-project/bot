import { Effect } from "effect";
import type { Execution } from "../shared/domain";
import { isGroupTurn, pi, type BotsContext } from "./bots-context";
import type { botsLookup } from "./bots-lookup";
import { latestMessagePreview, type MessageOrigin } from "./transcript";

type PageOptions = {
  before?: string | undefined;
  limit?: number | undefined;
};

/** Where a turn came from, as its transcript shows it: the owner, a group, a task, a credential, or another bot. */
export const botsOrigin = (context: BotsContext) => {
  const { agents, schedules } = context;

  const origin = (execution: Execution): Effect.Effect<MessageOrigin> =>
    Effect.gen(function* () {
      if (isGroupTurn(execution)) return { kind: "group" };

      if (execution.scheduleId) {
        const schedule = yield* schedules.get(execution.scheduleId);

        return { kind: "task", name: schedule?.name ?? "Scheduled task" };
      }

      const [prefix, subject] = execution.requestId.split(":");

      if (prefix === "script" && subject) {
        const schedule = yield* schedules.get(subject);

        return { kind: "script", name: schedule?.name ?? "Script task" };
      }

      if (prefix === "credential" && subject)
        return { kind: "credential", name: subject };

      if (prefix === "bot-request" && subject) return { kind: "bot_request" };

      if (prefix === "delegate" && subject) {
        const source = yield* agents.get(subject);

        return {
          kind: "bot",
          agentId: subject,
          name: source?.name ?? "Another bot",
        };
      }

      return { kind: "owner" };
    });

  return { origin };
};

/** A chat's transcript, with the error of its latest execution when that one failed. */
export const botsSnapshot = (
  context: BotsContext,
  lookup: ReturnType<typeof botsLookup>,
) => {
  const { executions, runtime } = context;
  const { conversation } = lookup;

  const snapshot = Effect.fn("Bots.snapshot")(function* (
    conversationId: string,
    options: { limit?: number | undefined },
  ) {
    const { agent: owner, conversation: found } =
      yield* conversation(conversationId);

    const read = yield* pi(() =>
      runtime.snapshot(owner, conversationId, options),
    );

    const latest = (yield* executions.list(owner.id)).find(
      (execution) => execution.conversationId === conversationId,
    );

    return {
      ...read,
      agentId: owner.id,
      conversation: found,
      error: latest?.status === "failed" ? latest.error : null,
    };
  });

  return { snapshot };
};

/** Sidebar summaries from durable history, without opening a chat. */
export const botsAgentPreviews = (context: BotsContext) => {
  const { agents, conversations, runtime } = context;

  const agentPreviews = Effect.gen(function* () {
    return yield* Effect.forEach(
      yield* agents.list,
      Effect.fnUntraced(function* (each) {
        const [first] = yield* conversations.list(each.id, true);

        if (!first) return { agent: each, lastMessage: "" };

        const history = yield* Effect.promise(() =>
          runtime.history(each, { limit: 200 }),
        );

        return {
          agent: each,
          lastMessage: latestMessagePreview(history.messages),
        };
      }),
      { concurrency: "unbounded" },
    );
  });

  return { agentPreviews };
};

/** The runtime's own reads: a chat's history and the jobs a bot started from it. */
export const botsRuntimeReads = (
  context: BotsContext,
  lookup: ReturnType<typeof botsLookup>,
) => {
  const { runtime } = context;
  const { agent } = lookup;

  const history = (agentId: string, options: PageOptions) =>
    agent(agentId).pipe(
      Effect.flatMap((owner) => pi(() => runtime.history(owner, options))),
    );

  const codingJobs = (agentId: string) =>
    agent(agentId).pipe(
      Effect.flatMap((owner) => pi(() => runtime.codingJobs(owner))),
    );

  const codingJobHistory = (
    agentId: string,
    name: string,
    options: PageOptions,
  ) =>
    agent(agentId).pipe(
      Effect.flatMap((owner) =>
        pi(() => runtime.codingJobHistory(owner, name, options)),
      ),
    );

  const desktopJobs = (agentId: string) =>
    agent(agentId).pipe(
      Effect.flatMap((owner) => pi(() => runtime.desktopJobs(owner))),
    );

  const desktopJobHistory = (
    agentId: string,
    name: string,
    options: PageOptions,
  ) =>
    agent(agentId).pipe(
      Effect.flatMap((owner) =>
        pi(() => runtime.desktopJobHistory(owner, name, options)),
      ),
    );

  return {
    history,
    codingJobs,
    codingJobHistory,
    desktopJobs,
    desktopJobHistory,
  };
};

/** Everything the bots read back for a caller: transcripts, jobs, previews, and where a turn came from. */
export const botsReads = (
  context: BotsContext,
  lookup: ReturnType<typeof botsLookup>,
) => {
  const { snapshot } = botsSnapshot(context, lookup);

  return {
    snapshot: (
      conversationId: string,
      options: { limit?: number | undefined } = {},
    ) => snapshot(conversationId, options),
    ...botsOrigin(context),
    ...botsAgentPreviews(context),
    ...botsRuntimeReads(context, lookup),
  };
};
