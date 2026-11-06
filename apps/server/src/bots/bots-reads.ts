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
import type { RuntimeWatch } from "./runtime";
import {
  latestMessagePreview,
  type PageOptions,
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

  const origin = (execution: Execution): Effect.Effect<InputOrigin> =>
    Effect.gen(function* () {
      const source = turnSource(execution);

      switch (source.kind) {
        case "event":
          return yield* eventOrigin(source);

        case "task":
        case "script":
          return {
            kind: source.kind,
            name:
              (yield* scheduleName(source.scheduleId)) ??
              (source.kind === "task"
                ? UNKNOWN_SCHEDULE_NAME
                : "Deleted script automation"),
          };
        case "bot": {
          const bot = yield* agents.get(source.agentId);

          return {
            kind: "bot",
            agentId: source.agentId,
            name: bot?.name ?? UNKNOWN_BOT_NAME,
          };
        }

        default:
          return source;
      }
    });

  const snapshot = Effect.fn("Bots.snapshot")(function* (
    conversationId: string,
    options: { limit?: number | undefined } = {},
  ) {
    const { agent: owner, conversation: found } =
      yield* conversation(conversationId);

    const read = yield* pi(() =>
      runtime.snapshot(owner, conversationId, options),
    );

    const latest = yield* executions.latestIn(conversationId);

    return {
      ...read,
      agentId: owner.id,
      conversation: found,
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
