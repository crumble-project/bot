import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { CALL_OWNER_TOOL_NAME, HANG_UP_TOOL_NAME } from "../contract/tools";
import { VOICE_CALL_GREETING_MAX } from "../contract/voice-gateway";
import { callOnly, chatOnly } from "../shared/chat-only";
import { CallConversation } from "./call-conversation";
import { VoiceGateway, type VoiceCallResult } from "./voice-gateway";

type Calls = Pick<VoiceGateway["Service"], "callRefusal" | "callOwner">;

type Offers = Pick<
  VoiceGateway["Service"],
  "callRefusal" | "callOwner" | "currentCall" | "hangUp"
>;

type HangUps = Pick<VoiceGateway["Service"], "hangUp">;

const OUTCOMES = {
  answered:
    "The owner answered and heard your greeting. Their reply arrives as a spoken message.",
  unanswered: "The owner did not answer.",
  busy: "The owner's phone was busy.",
  failed: "The call failed.",
  unacknowledged: "The voice gateway did not take the call.",
  timedOut: "The voice gateway did not report how the call ended.",
  revoked:
    "The voice gateway token was revoked or replaced, so the call ended.",
};

const outcomeText = (result: VoiceCallResult) =>
  result.outcome === "refused"
    ? result.reason
    : result.outcome === "failed" && result.error
      ? `The call failed: ${result.error}`
      : OUTCOMES[result.outcome];

const settledCleanly = (result: VoiceCallResult) =>
  result.outcome === "unanswered" || result.outcome === "busy";

export function callOwnerExtension(botId: string, calls: Calls) {
  const callOwner = defineTool({
    name: CALL_OWNER_TOOL_NAME,
    description:
      "Call the owner on the phone from your line. Use it only when the owner asked you to call, or for news too urgent to wait for a chat message. " +
      "The phone rings for up to 3 minutes; when the owner answers, they hear your greeting and your turn ends, and their reply arrives as a spoken message. " +
      "You cannot choose the number.",
    parameters: Type.Object({
      greeting: Type.String({
        minLength: 1,
        maxLength: VOICE_CALL_GREETING_MAX,
        description:
          "What you say when the owner answers: why you are calling, in one or two plain sentences.",
      }),
    }),
    callers: ["model"],
    // A rerun after a crash would ring the owner a second time.
    replay: "unsafe",
    execute: async ({ greeting }, api, context) => {
      const result = await Effect.runPromise(
        calls.callOwner({ key: `${botId}:${api.taskId}`, botId, greeting }),
        { signal: context.abortSignal },
      );

      return {
        output: [{ type: "text" as const, text: outcomeText(result) }],
        details: { outcome: result.outcome },
        ...(result.outcome === "answered"
          ? { control: { terminate: true as const } }
          : { isError: !settledCleanly(result) }),
      };
    },
  });

  // A spoken reply reaches only the line's bot chat.
  return chatOnly(defineExtension({ name: "voice-call", tools: [callOwner] }));
}

const hangUpResult = (ending: boolean) => ({
  output: [
    {
      type: "text" as const,
      text: ending
        ? "The call ends once your reply was read aloud."
        : "You are not on a call.",
    },
  ],
  isError: !ending,
});

export function hangUpExtension(botId: string, calls: HangUps) {
  const hangUp = defineTool({
    name: HANG_UP_TOOL_NAME,
    description:
      "Hang up the phone call you are on with the owner. Only this tool ends the call: saying goodbye does not. " +
      "Call it whenever the owner says goodbye or asks you to hang up, then write a short goodbye, which is read aloud before the line drops.",
    parameters: Type.Object({}),
    callers: ["model"],
    execute: async () =>
      hangUpResult(await Effect.runPromise(calls.hangUp(botId))),
  });

  return chatOnly(defineExtension({ name: "voice-hang-up", tools: [hangUp] }));
}

/** `hang_up` for an outside call's conversation; `objected` withholds the call's transcript once the call ends. */
export function outsideHangUpExtension(
  botId: string,
  callee: string,
  calls: HangUps,
) {
  const hangUp = defineTool({
    name: HANG_UP_TOOL_NAME,
    description:
      `Hang up the phone call you are on with ${callee}. Only this tool ends the call: saying goodbye does not. ` +
      "Call it when the goal is reached or cannot be reached, or after you said you will check and call back, then write a short goodbye, which is read aloud before the line drops.",
    parameters: Type.Object({
      objected: Type.Optional(
        Type.Boolean({
          description: `True when ${callee} objected to talking to an AI or to the transcription: the call's transcript is then withheld from the owner.`,
        }),
      ),
    }),
    callers: ["model"],
    execute: async ({ objected }, api, context) => {
      if (objected)
        await api.commit(async (tx) => {
          (await tx.doc(CallConversation, api.conversationId)).objected = true;
        }, context);

      return hangUpResult(await Effect.runPromise(calls.hangUp(botId)));
    },
  });

  return callOnly(
    defineExtension({ name: "outside-call-hang-up", tools: [hangUp] }),
  );
}

async function voiceOffers(agentId: string, gateway: Offers) {
  const call = await Effect.runPromise(gateway.currentCall(agentId));

  if (call?.party === "outside")
    return [
      outsideHangUpExtension(agentId, call.callee ?? "the callee", gateway),
    ];

  if (call) return [hangUpExtension(agentId, gateway)];

  return (await Effect.runPromise(gateway.callRefusal(agentId)))
    ? []
    : [callOwnerExtension(agentId, gateway)];
}

export const callOwnerTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const gateway = yield* VoiceGateway;

    yield* (yield* BotExtensions).register(ExtensionPosition.voice, (agent) =>
      voiceOffers(agent.id, gateway),
    );
  }),
);
