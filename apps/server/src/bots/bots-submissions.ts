import { Effect } from "effect";
import type { AttachmentInput } from "../shared/attachment-rules";
import { attachmentDigest, validAttachments } from "../shared/attachments";
import { validTimezone } from "../contract/cron";
import type { Execution } from "../shared/domain";
import { Conflict, REQUEST_ID_REUSED, type AppError } from "../shared/errors";
import type { BotsAnnouncements } from "./bots-announcements";
import type { BotsChat } from "./bots-chat";
import { isGroupTurn, type BotsContext } from "./bots-context";
import type { BotsLookup } from "./bots-lookup";
import type { BotsNotifications } from "./bots-notifications";
import { OWNER_TIMEZONE } from "./runtime";

export type SendOptions = {
  scheduleId?: string;
  replyTo?: string | undefined;
  attachments?: AttachmentInput[] | undefined;
};

export type JobAnswerInput = {
  name: string;
  questionId: string;
  text: string;
  by?: string;
};

type SubmissionDeps = {
  lookup: BotsLookup;
  chat: BotsChat["chat"];
  notifications: BotsNotifications;
  announcements: BotsAnnouncements;
  admit: (execution: Execution) => Effect.Effect<void, AppError>;
};

const conflict = (message: string) => Effect.fail(new Conflict({ message }));

const differsFrom = (
  existing: Execution,
  content: string,
  replyTo: string | null,
  attachmentsDigest: string | null,
) =>
  existing.prompt !== content ||
  (existing.replyTo ?? null) !== replyTo ||
  (existing.attachmentsDigest ?? null) !== attachmentsDigest;

export const botsSubmissions = (context: BotsContext, deps: SubmissionDeps) => {
  const { executions, runtime, settings } = context;
  const { conversation, withAgent } = deps.lookup;
  const { changed } = deps.notifications;
  const { forkPreview } = deps.announcements;
  const { admit, chat } = deps;

  const send = Effect.fn("Bots.send")(function* (
    conversationId: string,
    content: string,
    requestId: string,
    options: SendOptions = {},
  ) {
    const { agent: owner } = yield* conversation(conversationId);

    if (!owner.enabled)
      return yield* conflict("Enable this agent before starting work");
    const replyTo = options.replyTo ?? null;
    const attachments = options.attachments ?? [];
    yield* validAttachments(attachments);
    const attachmentsDigest = attachmentDigest(attachments);

    const existing = yield* executions.getByRequest(conversationId, requestId);

    if (existing && differsFrom(existing, content, replyTo, attachmentsDigest))
      return yield* conflict(REQUEST_ID_REUSED);

    const execution =
      existing ??
      (yield* executions.create({
        agentId: owner.id,
        conversationId,
        scheduleId: options.scheduleId ?? null,
        requestId,
        prompt: content,
        replyTo,
        attachments,
        attachmentsDigest,
        submissionId: null,
        status: "pending",
        error: null,
      }));

    yield* admit(execution);
    yield* changed(conversationId);

    if (!isGroupTurn(execution))
      yield* forkPreview(execution.agentId, conversationId, execution.id);

    return (yield* executions.get(execution.id))!;
  });

  const notice = Effect.fn("Bots.notice")(function* (
    agentId: string,
    content: string,
    requestId: string,
  ) {
    return yield* send((yield* chat(agentId)).id, content, requestId);
  });

  const sendChat = Effect.fn("Bots.sendChat")(function* (
    agentId: string,
    content: string,
    requestId: string,
    replyTo?: string,
    attachments: AttachmentInput[] = [],
    timezone?: string,
  ) {
    if (timezone && validTimezone(timezone))
      yield* settings.set(OWNER_TIMEZONE, timezone);

    return yield* send((yield* chat(agentId)).id, content, requestId, {
      replyTo,
      attachments,
    });
  });

  const dispatch = Effect.fn("Bots.dispatch")(function* (
    agentId: string,
    prompt: string,
    requestId: string,
    scheduleId: string,
  ) {
    const existing = yield* executions.findByRequest(agentId, requestId);

    if (existing) {
      yield* admit(existing);

      return existing;
    }

    return yield* send((yield* chat(agentId)).id, prompt, requestId, {
      scheduleId,
    });
  });

  const answerJob = (agentId: string, kind: string, answer: JobAnswerInput) =>
    withAgent(agentId, (owner) => runtime.answerJob(owner, kind, answer)).pipe(
      Effect.flatMap((answered) =>
        answered
          ? Effect.void
          : conflict("The job no longer waits on this question"),
      ),
    );

  return { send, notice, sendChat, dispatch, answerJob };
};
