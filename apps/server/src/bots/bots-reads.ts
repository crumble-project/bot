import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import type { Execution } from "../shared/domain";
import type { BotsContext } from "./bots-context";
import type { botsLookup } from "./bots-lookup";
import { DELETED_SOURCE } from "../event-sources/event-repository";
import { askingBot, parseRequestId } from "../shared/request-ids";
import type { MessageOrigin } from "./entries";
import type { RuntimeWatch } from "./runtime";
import { latestMessagePreview, type PageOptions } from "./transcript";
import type { JobKindName } from "../jobs/job-kinds";

/** Where a turn came from, as its transcript shows it: the owner, a group, a task, a credential, or another bot. */
export const botsOrigin = (context: BotsContext) => {
  const { agents, schedules, events } = context;

  const eventOrigin = Effect.fnUntraced(function* (run: {
    eventId: string;
    scheduleId: string;
  }) {
    const schedule = yield* schedules.get(run.scheduleId);
    const event = yield* events.eventWithSource(run.eventId);

    return {
      kind: "event",
      name: schedule?.name ?? "Automation",
      source: event?.sourceName ?? DELETED_SOURCE,
    } satisfies MessageOrigin;
  });

  const botOrigin = (agentId: string) =>
    Effect.map(agents.get(agentId), (source) => ({
      kind: "bot",
      agentId,
      name: source?.name ?? "Another bot",
    }));

  const origin = (execution: Execution): Effect.Effect<MessageOrigin> =>
    Effect.gen(function* () {
      const request = parseRequestId(execution.requestId);

      if (request.kind === "group-turn") return { kind: "group" };

      if (request.kind === "event") return yield* eventOrigin(request);

      if (execution.scheduleId) {
        const schedule = yield* schedules.get(execution.scheduleId);

        return { kind: "task", name: schedule?.name ?? "Scheduled task" };
      }

      const asking = askingBot(request);

      if (asking) return yield* botOrigin(asking);

      switch (request.kind) {
        case "script": {
          const schedule = yield* schedules.get(request.scheduleId);

          return { kind: "script", name: schedule?.name ?? "Script task" };
        }

        // MessageOrigin documents no login kind, and clients label a login like a credential.
        case "notice":
          return { kind: "credential", name: request.name };
        case "bot-request":
          return { kind: "bot_request" };
        case "gateway":
          return { kind: "owner", via: request.adapterId };
        default:
          return { kind: "owner" };
      }
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

/** The runtime's own reads: a chat's history, the jobs a bot started from it, and an attachment. */
export const botsRuntimeReads = (
  context: BotsContext,
  lookup: ReturnType<typeof botsLookup>,
) => {
  const { runtime } = context;
  const { withAgent } = lookup;

  return {
    history: (agentId: string, options: PageOptions) =>
      withAgent(agentId, (owner) => runtime.history(owner, options)),
    jobs: (agentId: string, kind: JobKindName) =>
      withAgent(agentId, (owner) => runtime.jobs(owner, kind)),
    jobHistory: (
      agentId: string,
      kind: JobKindName,
      name: string,
      options: PageOptions,
    ) =>
      withAgent(agentId, (owner) =>
        runtime.jobHistory(owner, kind, name, options),
      ),
    attachment: (agentId: string, entryId: string, index: number) =>
      withAgent(agentId, (owner) => runtime.attachment(owner, entryId, index)),
    watch: (
      agentId: string,
      conversationId: string,
      callback: RuntimeWatch,
      options: { limit?: number | undefined },
    ) =>
      withAgent(agentId, (owner) =>
        runtime.watch(owner, conversationId, callback, options),
      ),
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
