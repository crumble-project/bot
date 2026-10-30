import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai";
import type {
  ConversationId,
  DocumentReader,
  ToolExecutionApi,
} from "@earendil-works/pi-durable";
import type { IntentGate } from "../bot-desktop/computer-use-intent";
import type { HeldActionsAccess } from "../bot-desktop/held-actions";
import {
  checkIntent,
  describeAction,
  type IntentVerdict,
  type Judge,
} from "../bot-desktop/intent-check";
import {
  judgeModel,
  judgeWith,
  type JudgeModelRef,
} from "../bot-desktop/intent-judge";
import type { JobRequest } from "./owner-request";

export const HELD_ACTION_ENTRY = "crumble.held-action";

/** What desktop jobs check their actions with: the account's judge, and where held actions wait for the owner. */
export type DesktopIntent = {
  /** The judge over the harness's models, and its name; undefined when no model can judge. */
  judgeFor(models: Models): Promise<{ judge: Judge; name: string } | undefined>;
  held: HeldActionsAccess;
};

/** The judge the owner chose, else the default: the account's judge model over the harness's models. */
export const accountJudge =
  (chosen: () => Promise<JudgeModelRef | undefined>) =>
  async (models: Models) => {
    const model = await judgeModel(models, await chosen());

    return model && { judge: judgeWith(models, model), name: model.name };
  };

type ReadRequest = (
  reader: DocumentReader,
  conversationId: ConversationId,
  context: Context,
) => Promise<JobRequest>;

const percent = (value: number) => `${Math.round(value * 100)}%`;

/** Why an action was held, in the owner's words. */
function holdReason(verdict: IntentVerdict, model: string | undefined) {
  const { answer, commitPoint, judgeError } = verdict;
  const floor = commitPoint ? "It looks like a commit point." : "";

  if (judgeError)
    return `${floor} The judge (${model}) failed: ${judgeError}`.trim();

  if (!answer) return `${floor} No judge model is available.`.trim();

  return `${floor} ${model} rated it irreversible at ${percent(answer.irreversible)} and asked for at ${percent(answer.inIntent)}.`.trim();
}

function refusal(
  action: string,
  decision: Awaited<ReturnType<HeldActionsAccess["until"]>>,
) {
  if (decision.status === "declined")
    return `REFUSED: the owner declined: ${action}.${decision.reason ? ` Their reason: ${decision.reason}` : ""} Don't retry it; report what you did and what is left.`;

  return `REFUSED: ${action} was waiting for the owner's approval, and the wait ended without an answer. Report what you did and what is left.`;
}

/** What one call's intent check reads and writes in the job's conversation. */
export type GateCall = {
  models: Models;
  request(context: Context): Promise<JobRequest>;
  /** Shows a held action's card in the bot chat. */
  postCard(
    chatId: ConversationId,
    card: { id: string; job: string; action: string },
    context: Context,
  ): Promise<void>;
};

/** A call's reads and writes through its tool API. */
export const gateCallOf = (
  api: ToolExecutionApi,
  readRequest: ReadRequest,
): GateCall => ({
  models: api.models,
  request: (context) => readRequest(api, api.conversationId, context),
  postCard: async (chatId, card, context) => {
    await api.commit(
      (tx) =>
        tx.appendEntry(chatId, {
          kind: HELD_ACTION_ENTRY,
          data: { ...card, timestamp: api.now() },
        }),
      context,
    );
  },
});

/** The intent check of one desktop job call: held actions post a card to the bot chat and wait for the owner. */
export const desktopIntentGate =
  (intent: DesktopIntent, agentId: string, call: GateCall): IntentGate =>
  async ({ action, page }, context) => {
    const request = await call.request(context);
    const judge = await intent.judgeFor(call.models);

    const verdict = await checkIntent(
      judge?.judge,
      {
        ownerMessages: request.ownerMessages,
        tasks: request.tasks,
        action,
      },
      context.abortSignal,
    );

    const usage = verdict.answer?.usage;
    const spent = usage ? { usage } : {};

    if (!verdict.held) return spent;

    const words = describeAction(action);
    const job = request.job;

    // A job that got no start or send since intent checks began has nowhere to show the card.
    if (!job)
      return {
        ...spent,
        refusal: `REFUSED: ${words} needs the owner's approval, and this job can't ask for it. Report what you did and what is left.`,
      };

    const held = await intent.held.hold({
      agentId,
      job: job.name,
      action: words,
      page: page ?? null,
      ownerMessages: request.ownerMessages,
      reason: holdReason(verdict, judge?.name),
    });

    await call.postCard(
      job.chatId,
      { id: held.id, job: job.name, action: words },
      context,
    );

    const decision = await intent.held.until(held.id, context);

    return decision.status === "approved"
      ? spent
      : { ...spent, refusal: refusal(words, decision) };
  };
