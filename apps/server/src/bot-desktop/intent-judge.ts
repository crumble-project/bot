import {
  calculateCost,
  isModelType,
  type AnyModel,
  type ClassifierModel,
  type ClassifierApi,
  type ClassifierContext,
  type Model,
  type Api,
  type Models,
  type Usage,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  JUDGE_QUESTIONS,
  judgeState,
  type Judge,
  type IntentRequest,
} from "./intent-check";

/** The account's judge model: a classifier, or a chat model that answers the same questions. */
export type JudgeModelRef = { provider: string; model: string };

export const DEFAULT_JUDGE: JudgeModelRef = {
  provider: "openai",
  model: "gpt-6-luna",
};

// Each classifier's in-intent bar, set from `bun tools/intent-eval.ts`: Jev put every action the owner asked for at 55%
// or more and every one they didn't at 42% or less (38 cases, 2026-10-30). A model nobody evaluated must be sure.
const IN_INTENT_BARS = new Map([["typesafe/jev-latest", 0.5]]);
const UNEVALUATED_BAR = 0.9;

// A chat judge answers 0 or 1, so any bar between them reads its answer.
const CHAT_BAR = 0.5;

// $ per million tokens where pi-ai's catalog lists none: TypeSafe's stated price for Jev.
const JUDGE_PRICES = new Map([
  [
    "typesafe/jev-latest",
    { input: 0.042, output: 0, cacheRead: 0, cacheWrite: 0 },
  ],
]);

/** The call's usage priced at the catalog's price, or at the judge's known price where the catalog lists none. */
export function judgeUsage(model: AnyModel, usage: Usage): Usage {
  const price = JUDGE_PRICES.get(`${model.provider}/${model.id}`);

  if (!price || model.cost.input > 0) return usage;

  return {
    ...usage,
    cost: calculateCost({ ...model, cost: { ...model.cost, ...price } }, usage),
  };
}

/** The in-intent probability a classifier must reach for an irreversible action to run. */
export const inIntentBar = (model: AnyModel) =>
  IN_INTENT_BARS.get(`${model.provider}/${model.id}`) ?? UNEVALUATED_BAR;

// Used in this order when no key reaches a classifier.
const SMALL_CHAT_MODELS: JudgeModelRef[] = [
  { provider: "anthropic", model: "claude-haiku-5-5" },
  { provider: "openai", model: "gpt-6-luna" },
];

const CHAT_INSTRUCTIONS = [
  "You check a desktop agent's next action for its owner. Answer two questions about the JSON state the user sends.",
  `irreversible: ${JUDGE_QUESTIONS.irreversible.instructions} true: ${JUDGE_QUESTIONS.irreversible.criteria.true} false: ${JUDGE_QUESTIONS.irreversible.criteria.false}`,
  `in_intent: ${JUDGE_QUESTIONS.in_intent.instructions} true: ${JUDGE_QUESTIONS.in_intent.criteria.true} false: ${JUDGE_QUESTIONS.in_intent.criteria.false}`,
  'Reply with only a JSON object: {"irreversible": true|false, "in_intent": true|false}.',
].join("\n\n");

const chatAnswer = z.object({
  irreversible: z.boolean(),
  in_intent: z.boolean(),
});

const sameRef = (model: AnyModel, ref: JudgeModelRef) =>
  model.provider === ref.provider && model.id === ref.model;

/** What a classifier judge is asked; the intent eval sends the same. */
export const classifierContext = (
  request: IntentRequest,
): ClassifierContext => ({
  state: judgeState(request),
  questions: {
    irreversible: { type: "bool", ...JUDGE_QUESTIONS.irreversible },
    in_intent: { type: "bool", ...JUDGE_QUESTIONS.in_intent },
  },
});

function classifierJudge(
  models: Models,
  model: ClassifierModel<ClassifierApi>,
): Judge {
  return async (request: IntentRequest, signal: AbortSignal | undefined) => {
    const result = await models.classify(
      model,
      classifierContext(request),
      signal ? { signal } : {},
    );

    const irreversible = result.answers["irreversible"];
    const inIntent = result.answers["in_intent"];

    if (
      result.stopReason !== "stop" ||
      irreversible?.type !== "bool" ||
      inIntent?.type !== "bool"
    )
      throw new Error(result.errorMessage ?? "The judge gave no answer");

    return {
      irreversible: irreversible.probability,
      inIntent: inIntent.probability,
      inIntentBar: inIntentBar(model),
      ...(result.usage && { usage: judgeUsage(model, result.usage) }),
    };
  };
}

const jsonIn = (text: string) =>
  text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);

function chatJudge(models: Models, model: Model<Api>): Judge {
  return async (request: IntentRequest, signal: AbortSignal | undefined) => {
    const reply = await models.completeSimple(
      model,
      {
        systemPrompt: CHAT_INSTRUCTIONS,
        messages: [
          {
            role: "user",
            content: JSON.stringify(judgeState(request)),
            timestamp: Date.now(),
          },
        ],
      },
      signal ? { signal } : {},
    );

    if (reply.stopReason === "error" || reply.stopReason === "aborted")
      throw new Error(reply.errorMessage ?? "The judge gave no answer");

    const text = reply.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("");

    const parsed = chatAnswer.safeParse(
      (() => {
        try {
          return JSON.parse(jsonIn(text));
        } catch {
          return undefined;
        }
      })(),
    );

    if (!parsed.success) throw new Error("The judge's answer was unreadable");

    return {
      irreversible: parsed.data.irreversible ? 1 : 0,
      inIntent: parsed.data.in_intent ? 1 : 0,
      inIntentBar: CHAT_BAR,
      usage: reply.usage,
    };
  };
}

/** The classifier models the account's keys reach: the owner's choices of judge. */
export const judgeChoices = (models: Models) =>
  models.getAvailableOfType("classifier");

/**
 * The model that judges: the owner's classifier, else GPT-6 Luna, else any classifier, else a small chat model. None
 * when no key reaches one; a choice whose key is gone falls back the same way.
 */
export async function judgeModel(
  models: Models,
  chosen: JudgeModelRef | undefined,
): Promise<AnyModel | undefined> {
  const classifiers = await judgeChoices(models);

  const classifier =
    (chosen && classifiers.find((model) => sameRef(model, chosen))) ??
    classifiers.find((model) => sameRef(model, DEFAULT_JUDGE)) ??
    classifiers[0];

  if (classifier) return classifier;

  const chat = await models.getAvailableOfType("chat");

  return SMALL_CHAT_MODELS.flatMap(
    (ref) => chat.find((model) => sameRef(model, ref)) ?? [],
  )[0];
}

export function judgeWith(models: Models, model: AnyModel): Judge {
  if (isModelType(model, "classifier")) return classifierJudge(models, model);

  if (isModelType(model, "chat")) return chatJudge(models, model);

  throw new Error(`${model.name} can't judge`);
}
