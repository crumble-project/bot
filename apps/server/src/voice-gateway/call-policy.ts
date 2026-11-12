import type {
  CallParty,
  VoiceGatewayServedConfig,
} from "../contract/voice-gateway";

type CallAvailability = {
  connected: boolean;
  othersAllowed: ReadonlySet<string>;
  active: ReadonlySet<string>;
  ringing: ReadonlySet<string>;
};

// A call to the owner is refused to its bot; an outside call to the owner approving it.
const REFUSALS = {
  owner: {
    noLine: "You have no line.",
    switchedOff: "Calls to the owner are switched off for your line.",
    onCall: "You are on a call with the owner now.",
    ringing: "A call to the owner is already ringing.",
  },
  outside: {
    noLine: "The bot has no line.",
    switchedOff: "Calls to other people are switched off for the bot's line.",
    onCall: "The bot's line has a call now.",
    ringing: "A call on the bot's line is already ringing.",
  },
} satisfies Record<CallParty, Record<string, string>>;

const switchedOn = (
  line: VoiceGatewayServedConfig["lines"][number],
  party: CallParty,
  availability: CallAvailability,
) =>
  party === "owner"
    ? line.callsOwner
    : availability.othersAllowed.has(line.username);

const lineRefusal = (
  line: VoiceGatewayServedConfig["lines"][number],
  party: CallParty,
  availability: CallAvailability,
) => {
  const texts = REFUSALS[party];

  if (!switchedOn(line, party, availability)) return texts.switchedOff;

  if (!availability.connected)
    return "No voice gateway that can place calls is connected.";

  if (availability.active.has(line.username)) return texts.onCall;

  return availability.ringing.has(line.username) ? texts.ringing : null;
};

export const callLine = (
  current: VoiceGatewayServedConfig,
  botId: string,
  party: CallParty,
  availability: CallAvailability,
) => {
  const found = current.lines.find((served) => served.botId === botId);

  if (!current.enabled)
    return { refusal: "The voice gateway is disabled.", line: null };

  if (!found) return { refusal: REFUSALS[party].noLine, line: null };
  const refusal = lineRefusal(found, party, availability);

  return refusal ? { refusal, line: null } : { refusal, line: found };
};

export const callTarget = (
  current: VoiceGatewayServedConfig,
  botId: string,
  availability: CallAvailability,
) => {
  const { refusal, line } = callLine(current, botId, "owner", availability);

  return line
    ? {
        refusal,
        target: {
          username: line.username,
          to: current.ownerNumbers[0]!,
        },
      }
    : { refusal, target: null };
};
