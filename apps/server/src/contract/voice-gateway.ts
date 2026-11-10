import { z } from "@hono/zod-openapi";
import { CONNECTION_STATUSES } from "../shared/domain";
import { MAX_MESSAGE_CHARS } from "../shared/limits";

const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

const ownerNumber = z.string().regex(/^\+?[0-9*#]{1,32}$/u);

// The username is a path segment in the gateway's line routes, so "." and ".." are refused.
const sipUsername = z
  .string()
  .regex(/^[A-Za-z0-9._~+-]{1,64}$/u)
  .refine((name) => name !== "." && name !== "..", {
    message: "A SIP username cannot be . or ..",
  });

export const voiceGatewayConfigInput = z
  .object({
    enabled: z.boolean(),
    ownerNumbers: z.array(ownerNumber).max(20).openapi({
      description:
        "The owner's phone numbers. A call from one of them reaches the line's bot as the owner; a bot calling the owner dials the first.",
    }),
    lines: z
      .array(
        z
          .object({
            username: sipUsername,
            botId: z.uuid(),
            displayName: z.string().trim().max(64).nullable().openapi({
              description:
                "The caller name sent to the telephone system; null uses the bot's name.",
            }),
            callsOwner: z.boolean(),
            callsOthers: z.boolean().exactOptional().openapi({
              description:
                "Whether the line's bot may ask to call people other than the owner, each call after the owner approved it. Absent means false.",
            }),
          })
          .strict(),
      )
      .max(64),
  })
  .strict()
  .refine((input) => unique(input.lines.map((line) => line.username)), {
    message: "Line usernames must be unique",
    path: ["lines"],
  })
  .refine((input) => unique(input.lines.map((line) => line.botId)), {
    message: "A bot can answer only one line",
    path: ["lines"],
  })
  .refine((input) => unique(input.ownerNumbers), {
    message: "Owner numbers must be unique",
    path: ["ownerNumbers"],
  })
  .refine((input) => !input.enabled || input.ownerNumbers.length > 0, {
    message: "Add at least one owner number to enable the voice gateway",
    path: ["ownerNumbers"],
  });

export const voiceGatewayResponse = z.object({
  config: voiceGatewayConfigInput,
  token: z.object({ issuedAt: z.string() }).nullable(),
  status: z.enum(CONNECTION_STATUSES),
  connectedAt: z.string().nullable(),
  lines: z
    .array(
      z.object({
        username: z.string(),
        registered: z.boolean(),
        error: z.string().nullable(),
      }),
    )
    .openapi({
      description:
        "Line registration as the connected voice gateway last reported it; empty until it reports and after it disconnects.",
    }),
  unavailableLines: z
    .array(
      z.object({
        username: z.string(),
        reason: z.enum(["botDeleted", "botDisabled"]),
      }),
    )
    .openapi({
      description:
        "Configured lines whose bot was deleted or is disabled. The voice gateway does not receive them; a line comes back when its bot is enabled again.",
    }),
});

export const voiceGatewayTokenResponse = z.object({
  token: z.string(),
  issuedAt: z.string(),
});

export const voiceLineParams = z.object({
  username: z.string().openapi({
    param: { name: "username", in: "path", required: true },
    description:
      "A line's SIP username. An unknown line, or one whose bot is deleted or disabled, answers 404.",
  }),
});

export const spokenMessageInput = z.object({
  callId: z.uuid().openapi({
    description: "The call the message was spoken on.",
  }),
  requestId: z.uuid().openapi({
    description:
      "The message's ID within the call. Retrying with the same IDs and content returns the same execution.",
  }),
  content: z.string().trim().min(1).max(MAX_MESSAGE_CHARS),
});

export const voiceGatewayConfigEvent = z
  .object({
    enabled: z.boolean(),
    ownerNumbers: z.array(z.string()),
    lines: z
      .array(
        z.object({
          username: z.string(),
          botId: z.string(),
          botName: z.string(),
          displayName: z.string().openapi({
            description: "The line's display name, or the bot's name.",
          }),
          callsOwner: z.boolean(),
        }),
      )
      .openapi({
        description:
          "Lines whose bot is enabled; empty while the voice gateway is disabled.",
      }),
  })
  .openapi("VoiceGatewayConfigEvent");

export const voiceGatewayReplacedEvent = z
  .object({})
  .openapi("VoiceGatewayReplacedEvent", {
    description:
      "Another connection with the same voice gateway token took over; sent before this stream closes.",
  });

export const VOICE_CALL_GREETING_MAX = 1000;

export const CALL_PARTIES = ["owner", "outside"] as const;

export const voiceCallEvent = z
  .object({
    callId: z.uuid(),
    username: z.string().openapi({
      description: "The line the call is placed from.",
    }),
    to: z.string().openapi({
      description:
        "The number to dial: for a call to the owner, the first in the owner's list; for an outside call, the number the owner approved, digits with an optional leading +.",
    }),
    greeting: z.string().min(1).max(VOICE_CALL_GREETING_MAX).openapi({
      description:
        "What the bot says when the call is answered: for an outside call, the opening the owner approved, to be spoken verbatim.",
    }),
    party: z.enum(CALL_PARTIES).optional().openapi({
      description:
        "Who is called: owner, or outside, someone other than the owner after the owner approved the bot's call request. Absent means owner. Dial an outside call only when the voice gateway's own config allows it, else report it failed.",
    }),
  })
  .openapi("VoiceCallEvent", {
    description:
      "A bot asks to call the owner, or someone else after the owner approved it. Sent only to a stream opened with calls=true, and sent again after a reconnect until the call is acknowledged; ignore a callId you already dial.",
  });

export const voiceCallCancelEvent = z
  .object({ callId: z.uuid() })
  .openapi("VoiceCallCancelEvent", {
    description:
      "The call's turn was aborted or its wait ran out: hang up if it still rings.",
  });

export const voiceGatewayEventsInput = z.object({
  calls: z.stringbool().optional().openapi({
    description:
      "With calls=true, the voice gateway declares it can place calls: bots with a line that may call the owner are offered the call_owner tool, approved call requests can dial, and call events arrive on this stream.",
  }),
});

export const VOICE_CALL_OUTCOMES = [
  "ringing",
  "answered",
  "unanswered",
  "busy",
  "failed",
] as const;

export const VOICE_CALL_END_REASONS = [
  "hungUp",
  "maxDuration",
  "failed",
  "stopping",
] as const;

const callError = z.string().max(500).optional();

export const voiceCallReportInput = z
  .discriminatedUnion("outcome", [
    z
      .object({
        outcome: z.enum(VOICE_CALL_OUTCOMES).openapi({
          description:
            "For a call a bot placed: ringing acknowledges it as soon as dialing starts; the others settle it.",
        }),
        error: callError,
      })
      .strict(),
    z
      .object({
        outcome: z.literal("ended").openapi({
          description:
            "A started call ended. Accepted for an active, ended, or unknown call; an unknown one can't be started afterwards.",
        }),
        reason: z.enum(VOICE_CALL_END_REASONS).openapi({
          description:
            "hungUp: the media ended or the dialog closed. maxDuration: the call reached its maximum length. failed: any other error. stopping: the voice gateway shut down.",
        }),
        error: callError,
      })
      .strict(),
  ])
  .openapi("VoiceCallReport");

export const voiceCallParams = z.object({
  callId: z.string().openapi({
    param: { name: "callId", in: "path", required: true },
    description: "The callId of a call event.",
  }),
});

export const voiceLineCallParams = voiceLineParams.extend({
  callId: z.uuid().openapi({
    param: { name: "callId", in: "path", required: true },
    description:
      "The call's ID, the callId its spoken messages carry: a call event's callId for a call a bot placed.",
  }),
});

export const voiceCallStartInput = z.object({}).strict();

export const voiceLinesReportInput = z
  .object({
    lines: z
      .array(
        z
          .object({
            username: z.string().max(64),
            registered: z.boolean(),
            error: z.string().max(500).nullable(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();

export const CALL_REQUEST_STATUSES = [
  "pending",
  "declined",
  "calling",
  "ended",
] as const;

export const CALL_REQUEST_OUTCOMES = [
  "answered",
  "unanswered",
  "busy",
  "failed",
] as const;

export const CALL_CALLEE_MAX = 100;

export const CALL_GOAL_MAX = 1000;

export const callRequestResponse = z
  .object({
    id: z.string(),
    agentId: z.string(),
    number: z.string().openapi({
      description:
        "The number to dial, normalized: digits with an optional leading +.",
    }),
    callee: z.string().openapi({ description: "Who the bot calls." }),
    goal: z.string(),
    opening: z.string().openapi({
      description: "What the bot says first when the callee answers.",
    }),
    status: z.enum(CALL_REQUEST_STATUSES).openapi({
      description:
        "pending: waiting for the owner. calling: approved, and the call rings or runs. ended: see outcome.",
    }),
    callId: z.string().nullable(),
    conversationId: z.string().nullable(),
    outcome: z.enum(CALL_REQUEST_OUTCOMES).nullable().openapi({
      description: "Set once the status is ended.",
    }),
    error: z.string().nullable().openapi({
      description: "Why a failed call failed.",
    }),
    requestedAt: z.string(),
    decidedAt: z.string().nullable(),
    endedAt: z.string().nullable(),
  })
  .openapi("CallRequest");

export type CallRequest = z.infer<typeof callRequestResponse>;

export type CallParty = (typeof CALL_PARTIES)[number];

export type VoiceCallEvent = z.infer<typeof voiceCallEvent>;

export type VoiceCallReport = z.infer<typeof voiceCallReportInput>;

export type VoiceCallEndReason = (typeof VOICE_CALL_END_REASONS)[number];

export type VoiceLinesReport = z.infer<typeof voiceLinesReportInput>["lines"];

export type VoiceGatewayServedConfig = z.infer<typeof voiceGatewayConfigEvent>;

export type VoiceGatewayConfig = z.infer<typeof voiceGatewayConfigInput>;

export type VoiceGatewayDescription = z.infer<typeof voiceGatewayResponse>;

export const defaultVoiceGatewayConfig = (): VoiceGatewayConfig => ({
  enabled: false,
  ownerNumbers: [],
  lines: [],
});
