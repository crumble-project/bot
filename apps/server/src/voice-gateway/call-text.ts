import type { OutsideCallMiss, VoiceCallEnd } from "./voice-gateway";

const ENDED_BECAUSE: Record<VoiceCallEnd, string | null> = {
  hungUp: null,
  botHungUp: "the bot hung up",
  maxDuration: "it reached its maximum length",
  failed: "the call failed",
  stopping: "the voice gateway stopped",
  lost: "the voice gateway lost its connection",
  revoked: "the voice gateway token was revoked",
  lineChanged: "the line was given to another bot or turned off",
};

const OBJECTED =
  "the callee objected to the AI or the transcription, so the transcript is withheld";

const count = (value: number, unit: string) =>
  `${value} ${unit}${value === 1 ? "" : "s"}`;

function lasted(ms: number) {
  const minutes = Math.floor(ms / 60_000);

  if (minutes < 1) return "less than a minute";
  const hours = Math.floor(minutes / 60);

  if (!hours) return count(minutes, "minute");

  return minutes % 60
    ? `${count(hours, "hour")} ${count(minutes % 60, "minute")}`
    : count(hours, "hour");
}

/** The one line both the owner and the woken bot read. */
export function callEndedText(reason: VoiceCallEnd, ms: number) {
  const because = ENDED_BECAUSE[reason];

  return `Call ended after ${lasted(ms)}${because ? `: ${because}` : ""}.`;
}

/** An outside call's line: the owner reads it, and the woken bot reads it above the call's note. */
export function outsideEndedText(
  callee: string,
  reason: VoiceCallEnd,
  ms: number,
  objected: boolean,
) {
  const because = objected ? OBJECTED : ENDED_BECAUSE[reason];

  return `Call to ${callee} ended after ${lasted(ms)}${because ? `: ${because}` : ""}.`;
}

export function outsideMissedText(callee: string, miss: OutsideCallMiss) {
  switch (miss.outcome) {
    case "unanswered":
      return `Call to ${callee} was not answered.`;
    case "busy":
      return `Call to ${callee} was not answered: the line was busy.`;
    case "failed":
      return `Call to ${callee} failed${miss.error ? `: ${miss.error.replace(/\.$/u, "")}` : ""}.`;
  }
}
