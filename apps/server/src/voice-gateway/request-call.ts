import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Effect, Layer, Result } from "effect";
import { BotExtensions, ExtensionPosition } from "../bot-ports/bot-extensions";
import { REQUEST_CALL_TOOL_NAME } from "../contract/tools";
import {
  CALL_CALLEE_MAX,
  CALL_GOAL_MAX,
  VOICE_CALL_GREETING_MAX,
} from "../contract/voice-gateway";
import { chatOnly } from "../shared/chat-only";
import { errorText } from "../shared/errors";
import { toolOutput } from "../shared/tool-output";
import { CallRequests } from "./call-requests";
import { VoiceGateway } from "./voice-gateway";

const requestCallParameters = Type.Object({
  number: Type.String({
    minLength: 1,
    maxLength: 40,
    description:
      "The number to dial, in international form such as +49 30 1234567. Premium, service, satellite, and short numbers are refused.",
  }),
  callee: Type.String({
    minLength: 1,
    maxLength: CALL_CALLEE_MAX,
    description: "Who you call, as the owner will read it: Trattoria Roma.",
  }),
  goal: Type.String({
    minLength: 1,
    maxLength: CALL_GOAL_MAX,
    description:
      "What the call should achieve and its limits, such as: Book a table for 2 on Friday between 19:00 and 20:00. If full, ask about Saturday, same time.",
  }),
  opening: Type.String({
    minLength: 1,
    maxLength: VOICE_CALL_GREETING_MAX,
    description:
      "The first thing you say when they answer, read aloud word for word, in the callee's language.",
  }),
});

const requestCallTool = (agentId: string, service: CallRequests["Service"]) =>
  defineTool({
    name: REQUEST_CALL_TOOL_NAME,
    description:
      "Ask the owner to let you phone someone other than the owner from your line. The owner approves or declines the number, the callee, the goal, and your opening in this chat; approval dials at once, and you run the call in a separate conversation that has only the goal and the opening. " +
      "In your own words and in the callee's language, the opening must say that you are an AI assistant, with your name; whom you call for, by name; that the call is transcribed; and why you call. For example: Hi, this is Crumble, Leonhard's AI assistant. Just so you know, I transcribe this call. I'm calling about dinner on Friday. " +
      "Only one call request can be pending at a time. After calling, tell the owner what you proposed, then end your turn: a message arrives when the owner declines or the call ends.",
    parameters: requestCallParameters,
    callers: ["model"],
    replay: "unsafe",
    execute: async (args) => {
      const saved = await Effect.runPromise(
        Effect.result(service.request(agentId, args)),
      );

      if (Result.isFailure(saved))
        return {
          output: [{ type: "text" as const, text: errorText(saved.failure) }],
          isError: true,
        };

      // SAFETY: CallRequest holds only JSON data.
      const details = saved.success as JsonValue;

      return { ...toolOutput({ request: details }), details };
    },
  });

export const requestCallTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* CallRequests;
    const gateway = yield* VoiceGateway;

    yield* (yield* BotExtensions).register(
      ExtensionPosition.callRequests,
      async (agent) =>
        (await Effect.runPromise(gateway.callsOthers(agent.id))) &&
        (await Effect.runPromise(gateway.currentCall(agent.id)))?.party !==
          "outside"
          ? [
              chatOnly(
                defineExtension({
                  name: "call_requests",
                  tools: [requestCallTool(agent.id, service)],
                }),
              ),
            ]
          : [],
    );
  }),
);
