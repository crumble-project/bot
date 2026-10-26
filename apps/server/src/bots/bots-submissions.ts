import { Effect } from "effect";
import type { AttachmentInput } from "../shared/attachments";
import { attachmentDigest, prepareAttachments } from "../shared/attachments";
import { appErrors } from "../shared/app-errors";
import type { Execution } from "../shared/domain";
import { Conflict } from "../shared/errors";
import type { botsActivity } from "./bots-activity";
import type { botsAdmission } from "./bots-admission";
import type { botsAnnouncements } from "./bots-announcements";
import { isGroupTurn, type BotsContext } from "./bots-context";
import type { botsChat } from "./bots-chat";
import type { botsLookup } from "./bots-lookup";
import { OWNER_TIMEZONE } from "./runtime";

type SendOptions = {
  scheduleId?: string;
  replyTo?: string | undefined;
  attachments?: AttachmentInput[] | undefined;
};

type SendDeps = {
  lookup: ReturnType<typeof botsLookup>;
  notifications: ReturnType<typeof botsActivity>;
  announcements: ReturnType<typeof botsAnnouncements>;
  admit: ReturnType<typeof botsAdmission>["admit"];
};

const conflict = (message: string) => Effect.fail(new Conflict({ message }));

/** Validates attachments before anything is stored, so a bad file never leaves a failed execution behind. */
const validated = (attachments: AttachmentInput[]) =>
  appErrors(
    Effect.try({
      try: () => prepareAttachments(attachments),
      catch: (error) => error,
    }),
  );

const differsFrom = (
  existing: Execution,
  content: string,
  replyTo: string | null,
  attachmentsDigest: string | null,
) =>
  existing.prompt !== content ||
  (existing.replyTo ?? null) !== replyTo ||
  (existing.attachmentsDigest ?? null) !== attachmentsDigest;

/** Admits one message to a chat, or returns the execution its request ID already names. */
const botsSend = (context: BotsContext, deps: SendDeps) => {
  const { executions } = context;
  const { conversation } = deps.lookup;
  const { changed } = deps.notifications;
  const { forkPreview } = deps.announcements;
  const { admit } = deps;

  const send = Effect.fn("Bots.send")(function* (
    conversationId: string,
    content: string,
    requestId: string,
    options: SendOptions,
  ) {
    const { agent: owner } = yield* conversation(conversationId);

    if (!owner.enabled)
      return yield* conflict("Enable this agent before starting work");
    const replyTo = options.replyTo ?? null;
    const attachments = options.attachments ?? [];
    yield* validated(attachments);
    const attachmentsDigest = attachmentDigest(attachments);

    const existing = yield* executions.getByRequest(conversationId, requestId);

    if (existing && differsFrom(existing, content, replyTo, attachmentsDigest))
      return yield* conflict("Request ID already used for a different message");

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

  return { send };
};

const isTimezone = (timezone: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();

    return true;
  } catch {
    return false;
  }
};

type TurnDeps = SendDeps & {
  chat: ReturnType<typeof botsChat>["chat"];
  send: ReturnType<typeof botsSend>["send"];
};

/** The other ways a turn starts in a bot's chat: a notice, an owner's message with its timezone, and a dispatch. */
const botsTurns = (context: BotsContext, deps: TurnDeps) => {
  const { executions, settings } = context;
  const { chat, send } = deps;
  const { admit } = deps;

  const notice = Effect.fn("Bots.notice")(function* (
    agentId: string,
    content: string,
    requestId: string,
  ) {
    return yield* send((yield* chat(agentId)).id, content, requestId, {});
  });

  const sendChat = Effect.fn("Bots.sendChat")(function* (
    agentId: string,
    content: string,
    requestId: string,
    replyTo?: string,
    attachments: AttachmentInput[] = [],
    timezone?: string,
  ) {
    if (timezone && isTimezone(timezone))
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
    const existing = (yield* executions.list(agentId)).find(
      (execution) => execution.requestId === requestId,
    );

    if (existing) {
      yield* admit(existing);

      return existing;
    }

    return yield* send((yield* chat(agentId)).id, prompt, requestId, {
      scheduleId,
    });
  });

  return { notice, sendChat, dispatch };
};

type SubmissionDeps = SendDeps & { chat: ReturnType<typeof botsChat>["chat"] };

/** Everything that writes into a bot's chat, from an owner's message to a scheduled dispatch. */
export const botsSubmissions = (context: BotsContext, deps: SubmissionDeps) => {
  const { send } = botsSend(context, deps);

  return {
    send: (
      conversationId: string,
      content: string,
      requestId: string,
      options: SendOptions = {},
    ) => send(conversationId, content, requestId, options),
    ...botsTurns(context, { ...deps, send }),
  };
};
