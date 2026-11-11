import type { Effect } from "effect";
import type {
  CallParty,
  VoiceCallEndReason,
  VoiceCallEvent,
  VoiceCallReport,
  VoiceGatewayServedConfig,
} from "../contract/voice-gateway";
import type { NotFound } from "../shared/errors";
import type { CallEventData } from "../transcript/entries";

/** An outside call's ID and where its callee's words go; stored before its call event is sent. */
export type OutsideCall = {
  callId: string;
  requestId: string;
  conversationId: string;
  botId: string;
  callee: string;
};

type CallEnd = {
  outcome: Exclude<VoiceCallReport["outcome"], "ringing" | "ended">;
  error?: string | undefined;
};

/** How a pending call stops ringing: the voice gateway's report, or its token going away. */
type PendingEnd = CallEnd | { outcome: "revoked" };

export type SettledCall =
  | PendingEnd
  | { outcome: "unacknowledged" | "timedOut" };

export type VoiceCallResult =
  | SettledCall
  | { outcome: "refused"; reason: string };

/** `key` names the tool call, so running it again never dials again. */
export type CallRequest = { key: string; botId: string; greeting: string };

/** An approved call request to dial; its `requestId` is the key, so one request never dials twice. */
export type OutsideCallRequest = {
  botId: string;
  requestId: string;
  callId: string;
  conversationId: string;
  callee: string;
  number: string;
  opening: string;
};

/** Where a line's turns go: the bot chat, or the call conversation of the line's active outside call. */
export type LineRoute = VoiceLine & { outside: OutsideCall | null };

export type VoiceLine = { botId: string; generation: number };

/** Why a call ended: the voice gateway's report, or a lease rule when no report came. */
export type VoiceCallEnd =
  | VoiceCallEndReason
  | "botHungUp"
  | "lost"
  | "revoked"
  | "lineChanged";

/** `spoken`: a spoken message arrived on it. `confirmedAt`: its latest start report. `hangUp`: the bot asked to end it. */
export type VoiceCall = {
  callId: string;
  username: string;
  botId: string;
  direction: CallEventData["direction"];
  party: CallParty;
  greeting?: string | undefined;
  startedAt: number;
  confirmedAt: number;
  spoken: boolean;
  hangUp?: boolean | undefined;
};

/** How an outside call that never started settled; results the voice gateway did not report count as failed. */
export type OutsideCallMiss = {
  outcome: "unanswered" | "busy" | "failed";
  error?: string | undefined;
};

/** `wakes`: the end starts a bot turn, unless the bot is disabled. `missed`: an outside call that never started. */
export type VoiceCallChange =
  | { phase: "started"; call: VoiceCall }
  | {
      phase: "ended";
      call: VoiceCall;
      reason: VoiceCallEnd;
      endedAt: number;
      wakes: boolean;
    }
  | {
      phase: "missed";
      call: { callId: string; botId: string };
      miss: OutsideCallMiss;
    };

export type VoiceCallHandler = (change: VoiceCallChange) => Effect.Effect<void>;

export type CallConnection = {
  calls: boolean;
  openedAt: number;
  send: (
    message:
      | { event: "call"; data: VoiceCallEvent }
      | { event: "cancel"; data: { callId: string } },
  ) => void;
};

export type CallBoundary = {
  reconcile: () => Effect.Effect<VoiceGatewayServedConfig>;
  line: (
    current: VoiceGatewayServedConfig,
    username: string,
    hash: string,
  ) => Effect.Effect<VoiceLine | null, NotFound>;
  acceptsToken: (hash: string) => boolean;
  connection: () => CallConnection | null;
  allowsOthers: (username: string) => boolean;
};
