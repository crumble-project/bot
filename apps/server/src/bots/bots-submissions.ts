import { Effect } from "effect";
import type { Agent } from "../contract/agents";
import { pi } from "../shared/app-errors";
import { MAX_IMAGE_BYTES, attachmentKind } from "../shared/attachment-rules";
import { fileIdDigest } from "../shared/attachments";
import { groupTurnScope } from "../shared/request-ids";
import { validTimezone } from "../contract/cron";
import type { Execution } from "../shared/domain";
import {
  Conflict,
  InvalidInput,
  REQUEST_ID_REUSED,
  type AppError,
} from "../shared/errors";
import type { BotsAnnouncements } from "./bots-announcements";
import type { BotsChat } from "./bots-chat";
import { isChatTurn, type BotsContext } from "./bots-context";
import type { BotsLookup } from "./bots-lookup";
import type { BotsNotifications } from "./bots-notifications";
import { OWNER_TIMEZONE, unreadableImages } from "./runtime";

export type SendOptions = {
  scheduleId?: string;
  replyTo?: string | undefined;
  files?: string[] | undefined;
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
  const { executions, runtime, settings, library } = context;
  const { conversation, withAgent } = deps.lookup;
  const { changed } = deps.notifications;
  const { forkPreview } = deps.announcements;
  const { admit, chat } = deps;

  // Refuses before the turn is recorded, so the owner sees one error and the message goes back to the composer.
  const refuseUnreadableImages = Effect.fnUntraced(function* (
    owner: Agent,
    files: readonly string[],
  ) {
    const entries = yield* library.entries(
      { kind: "bot", agentId: owner.id },
      files,
    );

    const images = [...entries.values()].some(
      (entry) =>
        attachmentKind(entry.mimeType) === "image" &&
        entry.size <= MAX_IMAGE_BYTES,
    );

    if (images && !(yield* pi(() => runtime.acceptsImages(owner))))
      return yield* Effect.fail(
        new InvalidInput({ message: unreadableImages(owner) }),
      );
  });

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
    const files = options.files ?? [];
    const attachmentsDigest = fileIdDigest(files);

    const existing = yield* executions.getByRequest(conversationId, requestId);

    if (existing && differsFrom(existing, content, replyTo, attachmentsDigest))
      return yield* conflict(REQUEST_ID_REUSED);

    if (!existing && files.length && !groupTurnScope(requestId, owner.id)) {
      yield* runtime.validateFiles(owner.id, files);
      yield* refuseUnreadableImages(owner, files);
    }

    const execution =
      existing ??
      (yield* executions.create({
        agentId: owner.id,
        conversationId,
        scheduleId: options.scheduleId ?? null,
        requestId,
        prompt: content,
        replyTo,
        attachments: files,
        attachmentsDigest,
        submissionId: null,
        status: "pending",
        error: null,
      }));

    yield* admit(execution);
    yield* changed(conversationId);

    if (isChatTurn(execution))
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
    files: string[] = [],
    timezone?: string,
  ) {
    if (timezone && validTimezone(timezone))
      yield* settings.set(OWNER_TIMEZONE, timezone);

    return yield* send((yield* chat(agentId)).id, content, requestId, {
      replyTo,
      files,
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
