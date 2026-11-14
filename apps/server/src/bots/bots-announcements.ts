import { Effect } from "effect";
import { logged } from "../shared/app-errors";
import type { Agent } from "../contract/agents";
import type { Execution } from "../shared/domain";
import { MESSAGE_PREVIEW_CHARS } from "../shared/limits";
import type { InputOrigin } from "../transcript/origins";
import {
  latestMessagePreview,
  latestReply,
  type TranscriptMessage,
} from "../transcript/transcript";
import type { ChatSnapshot } from "./bots";
import type { BotsContext } from "./bots-context";
import type { BotsNotifications } from "./bots-notifications";
import type { AppError } from "../shared/errors";

type AnnouncementDeps = {
  notifications: BotsNotifications;
  snapshot: (conversationId: string) => Effect.Effect<ChatSnapshot, AppError>;
  origin: (execution: Execution) => Effect.Effect<InputOrigin>;
};

export type BotsAnnouncements = ReturnType<typeof botsAnnouncements>;

// A reaction ends a turn quietly, and so does a call's wake-up turn that wrote nothing.
const quiet = (
  { reply, reaction }: ReturnType<typeof latestReply>,
  origin: string,
) => !reply && (Boolean(reaction) || origin === "call");

export const botsAnnouncements = (
  context: BotsContext,
  deps: AnnouncementDeps,
) => {
  const { agents, activityListeners, scope } = context;
  const { emit } = deps.notifications;

  const preview = (owner: Agent, messages: TranscriptMessage[]) =>
    emit({
      type: "chat-preview",
      agentId: owner.id,
      agentName: owner.name,
      lastMessage: latestMessagePreview(messages),
    });

  const forkPreview = (
    agentId: string,
    conversationId: string,
    subject: string,
  ) =>
    Effect.gen(function* () {
      if (!activityListeners.size) return;
      const owner = yield* agents.get(agentId);

      if (!owner) return;
      const { messages } = yield* deps.snapshot(conversationId);

      yield* preview(owner, messages);
    }).pipe(
      logged("Chat preview announcement failed", subject),
      Effect.forkIn(scope),
      Effect.asVoid,
    );

  const announceReply = Effect.fnUntraced(function* (execution: Execution) {
    if (!activityListeners.size) return;
    const owner = yield* agents.get(execution.agentId);

    if (!owner) return;
    const { messages } = yield* deps.snapshot(execution.conversationId);

    yield* preview(owner, messages);

    const latest = latestReply(messages);
    const { reply, waitingFor } = latest;
    const origin = (yield* deps.origin(execution)).kind;

    if (quiet(latest, origin)) return;

    const surface = waitingFor ? latest.waiting : reply;

    if (surface && (!waitingFor || surface.toolCallId)) {
      yield* context.attention.register({
        eventId: execution.id,
        chat: { kind: "bot", id: owner.id },
        entryId: surface.entryId,
        messageId: surface.id,
        surface: waitingFor
          ? { kind: "tool-card", toolCallId: surface.toolCallId! }
          : { kind: "text" },
      });
    }

    yield* emit({
      type: "reply",
      executionId: execution.id,
      agentId: owner.id,
      agentName: owner.name,
      entryId: reply?.entryId ?? null,
      origin,
      preview: reply?.content.trim().slice(0, MESSAGE_PREVIEW_CHARS) ?? "",
      createdAt: execution.createdAt,
      ...(waitingFor && { waitingFor }),
    });
    yield* deps.notifications.changed(execution.conversationId);
  });

  return { forkPreview, announceReply };
};
