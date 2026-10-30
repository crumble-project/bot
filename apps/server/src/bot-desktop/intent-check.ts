import type { Usage } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { OwnerMessage } from "../jobs/owner-request";

/** The element an action acts on, as the job's latest capture or read named it. */
export type IntentTarget = { role?: string; name?: string };

export type IntentStep = {
  action: string;
  target?: IntentTarget;
  text?: string;
  keys?: string;
  value?: string;
};

/** An acting call: one step, or every step of a `steps` call, checked together. */
export type ProposedAction = { steps: IntentStep[]; host?: string };

/** What the judge reads. Page text is never part of it, so a page can't argue for its own action. */
export type IntentRequest = {
  ownerMessages: OwnerMessage[];
  tasks: string[];
  action: ProposedAction;
};

/** Probabilities in 0..1, and the in-intent probability this judge must reach for an irreversible action to run. */
export type JudgeAnswer = {
  irreversible: number;
  inIntent: number;
  inIntentBar: number;
  /** What the judge's call spent, when its service reports token counts. */
  usage?: Usage;
};

export type Judge = (
  request: IntentRequest,
  signal: AbortSignal | undefined,
) => Promise<JudgeAnswer>;

export type IntentVerdict = {
  held: boolean;
  irreversible: boolean;
  /** The target matched a known commit point. */
  commitPoint: boolean;
  /** Undefined when the judge failed or none is set; then the rules decide alone. */
  answer: JudgeAnswer | undefined;
  judgeError?: string;
};

export const ACTING_ACTIONS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type",
  "key",
  "set_value",
  "steps",
]);

const IRREVERSIBLE_AT = 0.5;

const COMMIT_WORDS = [
  // English
  "pay",
  "pay now",
  "buy",
  "buy now",
  "purchase",
  "order",
  "place order",
  "checkout",
  "check out",
  "send",
  "submit",
  "delete",
  "remove",
  "confirm",
  "book",
  "subscribe",
  "transfer",
  "publish",
  "post",
  "sign",
  // German
  "bezahlen",
  "zahlen",
  "jetzt bezahlen",
  "kaufen",
  "jetzt kaufen",
  "bestellen",
  "zahlungspflichtig bestellen",
  "senden",
  "absenden",
  "abschicken",
  "löschen",
  "entfernen",
  "bestätigen",
  "buchen",
  "abonnieren",
  "überweisen",
  "veröffentlichen",
  // French
  "payer",
  "acheter",
  "commander",
  "envoyer",
  "supprimer",
  "confirmer",
  "valider",
  "réserver",
  // Spanish and Portuguese
  "pagar",
  "comprar",
  "pedir",
  "enviar",
  "eliminar",
  "borrar",
  "excluir",
  "confirmar",
  "reservar",
  // Italian
  "paga",
  "acquista",
  "ordina",
  "invia",
  "elimina",
  "conferma",
  "prenota",
  // Dutch
  "betalen",
  "kopen",
  "verzenden",
  "verwijderen",
  "bevestigen",
];

const COMMIT_NAME = new RegExp(
  `(?<![\\p{L}\\p{N}])(${COMMIT_WORDS.map((word) => word.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

// Roles a press commits through; a field's label naming "Order number" is not one.
const CONTROL_ROLE = /button|link|menu ?item|option/i;
const ENTER_KEY = /(^|\+)(return|enter|kp_enter)$/i;
const PRESSES = new Set(["click", "double_click"]);

// A key goes to the focus, which may be a form field, so Enter always counts.
const isEnter = ({ action, keys }: IntentStep) =>
  action === "key" && ENTER_KEY.test(keys?.trim() ?? "");

const isCommitControl = ({ role, name }: IntentTarget) =>
  (!role || CONTROL_ROLE.test(role)) && COMMIT_NAME.test(name ?? "");

const isCommitPress = ({ action, target }: IntentStep) =>
  PRESSES.has(action) && target !== undefined && isCommitControl(target);

const stepIsCommitPoint = (step: IntentStep) =>
  isEnter(step) || isCommitPress(step);

/** The rule floor: a known commit point counts as irreversible whatever the judge says. */
export const isCommitPoint = (action: ProposedAction) =>
  action.steps.some(stepIsCommitPoint);

/** Rules only make the check stricter: a commit point is irreversible even when the judge disagrees. */
export function decide(
  commitPoint: boolean,
  answer: JudgeAnswer | undefined,
): Pick<IntentVerdict, "held" | "irreversible"> {
  const irreversible =
    commitPoint || (answer?.irreversible ?? 0) >= IRREVERSIBLE_AT;

  const inIntent = answer ? answer.inIntent >= answer.inIntentBar : false;

  return { irreversible, held: irreversible && !inIntent };
}

/** Runs the intent check; a failed or missing judge leaves the rules to decide. */
export async function checkIntent(
  judge: Judge | undefined,
  request: IntentRequest,
  signal: AbortSignal | undefined,
): Promise<IntentVerdict> {
  const commitPoint = isCommitPoint(request.action);

  if (!judge)
    return {
      ...decide(commitPoint, undefined),
      commitPoint,
      answer: undefined,
    };

  try {
    const answer = await judge(request, signal);

    return { ...decide(commitPoint, answer), commitPoint, answer };
  } catch (error) {
    signal?.throwIfAborted();

    return {
      ...decide(commitPoint, undefined),
      commitPoint,
      answer: undefined,
      judgeError: error instanceof Error ? error.message : String(error),
    };
  }
}

const quoted = (value: string | undefined) =>
  value === undefined ? "" : ` ${JSON.stringify(value)}`;

type StepWords = (step: IntentStep, on: string) => string;

const STEP_WORDS = new Map<string, StepWords>([
  ["type", ({ text }, on) => `type${quoted(text)}${on && ` into${on}`}`],
  ["set_value", ({ value }, on) => `set${on}${on && " to"}${quoted(value)}`],
  ["key", ({ keys }) => `press ${keys ?? "a key"}`],
]);

const otherWords: StepWords = ({ action }, on) =>
  `${action.replace("_", " ")}${on}`;

const targetWords = (target: IntentTarget | undefined) =>
  target ? ` ${target.role ?? "element"}${quoted(target.name)}` : "";

const stepWords = (step: IntentStep) =>
  (STEP_WORDS.get(step.action) ?? otherWords)(step, targetWords(step.target));

/** The action in plain words, for the owner's approval card and the judge. */
export function describeAction(action: ProposedAction) {
  const words = action.steps.map(stepWords).join(", then ");
  const sentence = words.charAt(0).toUpperCase() + words.slice(1);

  return action.host ? `${sentence} on ${action.host}` : sentence;
}

/** The judge's state: owner messages, the job's task, and the action with its target. */
export function judgeState(request: IntentRequest): JsonObject {
  const { ownerMessages, tasks, action } = request;

  return {
    owner_messages: ownerMessages.map((each) => ({
      from: each.from,
      text: each.text,
    })),
    job_task: tasks,
    proposed_action: {
      summary: describeAction(action),
      ...(action.host !== undefined && { host: action.host }),
      steps: action.steps.map((step) => ({
        action: step.action,
        ...(step.target && {
          target: {
            ...(step.target.role !== undefined && { role: step.target.role }),
            ...(step.target.name !== undefined && { name: step.target.name }),
          },
        }),
        ...(step.text !== undefined && { text: step.text }),
        ...(step.keys !== undefined && { keys: step.keys }),
        ...(step.value !== undefined && { value: step.value }),
      })),
    },
  };
}

export const JUDGE_QUESTIONS = {
  irreversible: {
    instructions:
      "A desktop agent is about to perform proposed_action in a browser or app. Would it have an effect that can't be undone or that others see: submitting a form, paying, ordering, sending a message, deleting, publishing, booking, or confirming?",
    criteria: {
      true: "The action commits, sends, pays, deletes, publishes, or confirms something.",
      false:
        "The action only navigates, opens, selects, types into a field without submitting, or is otherwise undoable.",
    },
  },
  in_intent: {
    instructions:
      "Did the owner ask for proposed_action, directly or as a necessary step of what they asked, in owner_messages? job_task is the agent's own paraphrase and counts only where owner_messages support it.",
    criteria: {
      true: "owner_messages ask for this action or clearly require it.",
      false:
        "owner_messages don't ask for it, ask for something else, or leave the decision open.",
    },
  },
} as const;
