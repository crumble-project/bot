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

    const { reply, reaction, waitingFor } = latestReply(messages);

    if (!reply && reaction) return;

    yield* emit({
      type: "reply",
      executionId: execution.id,
      agentId: owner.id,
      agentName: owner.name,
      entryId: reply?.entryId ?? null,
      origin: (yield* deps.origin(execution)).kind,
      preview: reply?.content.trim().slice(0, MESSAGE_PREVIEW_CHARS) ?? "",
      createdAt: execution.createdAt,
      ...(waitingFor && { waitingFor }),
    });
  });

  return { forkPreview, announceReply };
};
