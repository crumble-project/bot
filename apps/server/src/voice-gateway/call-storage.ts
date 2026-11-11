import { Effect } from "effect";
import { z } from "zod";
import { CALL_PARTIES } from "../contract/voice-gateway";
import type { SettingsRepository } from "../shared/settings-repository";
import { CALL_DIRECTIONS } from "../transcript/entries";
import type { OutsideCall, VoiceCall } from "./call-types";

const CALLS_KEY = "voice-gateway:calls";

const outsideCall = z.object({
  callId: z.string(),
  requestId: z.string(),
  conversationId: z.string(),
  botId: z.string(),
  callee: z.string(),
});

/** The active calls, the IDs of ended ones, and the outside calls' IDs, kept across a restart. */
const storedCalls = z.object({
  active: z.array(
    z.object({
      callId: z.string(),
      username: z.string(),
      botId: z.string(),
      direction: z.enum(CALL_DIRECTIONS),
      party: z.enum(CALL_PARTIES).optional(),
      greeting: z.string().optional(),
      startedAt: z.number(),
      confirmedAt: z.number(),
      spoken: z.boolean(),
      hangUp: z.boolean().optional(),
    }),
  ),
  ended: z.array(z.string()),
  outside: z.array(outsideCall).optional(),
});

export const loadCalls = Effect.fnUntraced(function* (
  settings: SettingsRepository["Service"],
) {
  const stored = storedCalls.safeParse(yield* settings.get(CALLS_KEY)).data;

  return {
    active:
      stored?.active.map((call): VoiceCall => ({
        ...call,
        party: call.party ?? "owner",
      })) ?? [],
    ended: stored?.ended ?? [],
    outside: stored?.outside ?? [],
  };
});

export const saveCalls = (
  settings: SettingsRepository["Service"],
  active: Iterable<VoiceCall>,
  ended: Iterable<string>,
  outside: Iterable<OutsideCall>,
) =>
  settings.set(CALLS_KEY, {
    active: [...active].map(({ greeting, hangUp, ...call }) => ({
      ...call,
      ...(greeting !== undefined && { greeting }),
      ...(hangUp !== undefined && { hangUp }),
    })),
    ended: [...ended],
    outside: [...outside],
  });
