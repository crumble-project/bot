import { workingOf } from "./working";
import { pi } from "../shared/app-errors";
import { Effect } from "effect";
import type { Execution } from "../shared/domain";
import type { BotsContext } from "./bots-context";
import type { BotsLookup } from "./bots-lookup";
import { DELETED_SOURCE } from "../event-sources/event-repository";
import {
  turnSource,
  UNKNOWN_BOT_NAME,
  UNKNOWN_SCHEDULE_NAME,
  type InputOrigin,
} from "../transcript/origins";
import type { RuntimeWatch, SnapshotOptions } from "./runtime";
import {
  latestMessagePreview,
  type PageOptions,
  type TranscriptMessage,
} from "../transcript/transcript";
import type { JobKindName } from "../shared/job-kinds";

export const botsReads = (context: BotsContext, lookup: BotsLookup) => {
  const { agents, conversations, events, executions, runtime, schedules } =
    context;

  const { conversation, withAgent } = lookup;

  const scheduleName = (scheduleId: string) =>
    Effect.map(schedules.get(scheduleId), (schedule) => schedule?.name);

  const eventOrigin = Effect.fnUntraced(function* (
    source: Extract<ReturnType<typeof turnSource>, { kind: "event" }>,
  ) {
    const event = yield* events.eventWithSource(source.eventId);

    return {
      kind: "event" as const,
      name: (yield* scheduleName(source.scheduleId)) ?? "Automation",
      source: event?.sourceName ?? DELETED_SOURCE,
    };
  });

  const scheduleOrigin = (
    source: Extract<
      ReturnType<typeof turnSource>,
      { kind: "task" } | { kind: "script" }
    >,
  ) =>
    Effect.map(scheduleName(source.scheduleId), (name) => ({
      kind: source.kind,
      name:
        name ??
        (source.kind === "task"
          ? UNKNOWN_SCHEDULE_NAME
          : "Deleted script automation"),
    }));

  // An outside call's conversation is titled with the callee.
  const calleeOrigin = (execution: Execution) =>
    Effect.map(conversations.get(execution.conversationId), (found) => ({
      kind: "callee" as const,
      name: found?.title ?? "The callee",
    }));

  const origin = (execution: Execution): Effect.Effect<InputOrigin> =>
    Effect.gen(function* () {
      const source = turnSource(execution);

      if (source.kind === "event") return yield* eventOrigin(source);

      if (source.kind === "task" || source.kind === "script")
        return yield* scheduleOrigin(source);

      if (source.kind === "bot") {
        const bot = yield* agents.get(source.agentId);

        return {
          kind: "bot",
          agentId: source.agentId,
          name: bot?.name ?? UNKNOWN_BOT_NAME,
        };
      }

      if (source.kind === "callee") return yield* calleeOrigin(execution);

      return source;
    });

  const withReferences = Effect.fnUntraced(function* (
    agentId: string,
    messages: TranscriptMessage[],
  ) {
    const references = yield* context.attention.references(
      { kind: "bot", id: agentId },
      messages.map((message) => message.id),
    );

    return messages.map((message) => ({
      ...message,
      replyReferences: [...(references.get(message.id) ?? [])],
    }));
  });

  const snapshot = Effect.fn("Bots.snapshot")(function* (
    conversationId: string,
    options: SnapshotOptions = {},
  ) {
    const { agent: owner, conversation: found } =
      yield* conversation(conversationId);

    const read = yield* pi(() =>
      runtime.snapshot(owner, conversationId, options),
    );

    const latest = yield* executions.latestIn(conversationId);

    return {
      ...read,
      messages: yield* withReferences(owner.id, read.messages),
      agentId: owner.id,
      conversation: found,
      working: workingOf(read.status, read.partial, read.messages),
      error: latest?.status === "failed" ? latest.error : null,
    };
  });

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

  return {
    origin,
    snapshot,
    agentPreviews,
    history: Effect.fn("Bots.history")(function* (
      agentId: string,
      options: PageOptions,
    ) {
      const page = yield* withAgent(agentId, (owner) =>
        runtime.history(owner, options),
      );

      return {
        ...page,
        messages: yield* withReferences(agentId, page.messages),
      };
    }),
    jobs: (agentId: string, kind: JobKindName) =>
      withAgent(agentId, (owner) => runtime.jobs(owner, kind)),
    jobHistory: Effect.fn("Bots.jobHistory")(function* (
      agentId: string,
      kind: JobKindName,
      name: string,
      options: PageOptions,
    ) {
      const page = yield* withAgent(agentId, (owner) =>
        runtime.jobHistory(owner, kind, name, options),
      );

      return {
        ...page,
        messages: yield* withReferences(agentId, page.messages),
      };
    }),
    attachment: (agentId: string, entryId: string, index: number) =>
      withAgent(agentId, (owner) => runtime.attachment(owner, entryId, index)),
    watch: (
      agentId: string,
      conversationId: string,
      callback: RuntimeWatch,
      options: SnapshotOptions,
    ) =>
      withAgent(agentId, (owner) =>
        runtime.watch(owner, conversationId, callback, options),
      ),
  };
};
