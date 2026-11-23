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

type PendingEnd = CallEnd | { outcome: "revoked" };

export type SettledCall =
  | PendingEnd
  | { outcome: "unacknowledged" | "timedOut" };

export type VoiceCallResult =
  | SettledCall
  | { outcome: "refused"; reason: string };

export type CallRequest = { key: string; botId: string; greeting: string };

export type OutsideCallRequest = {
  botId: string;
  requestId: string;
  callId: string;
  conversationId: string;
  callee: string;
  number: string;
  opening: string;
};

export type LineRoute = VoiceLine & { outside: OutsideCall | null };

export type VoiceLine = { botId: string; generation: number };

export type VoiceCallEnd =
  | VoiceCallEndReason
  | "botHungUp"
  | "lost"
  | "revoked"
  | "lineChanged";

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

export type OutsideCallMiss = {
  outcome: "unanswered" | "busy" | "failed";
  error?: string | undefined;
};

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
