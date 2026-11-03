import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "../shared/domain";
import { Effect, Layer } from "effect";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { BotMessaging, botMessagingAccess } from "./bot-messaging";
import { toolOutput } from "../shared/tool-output";

const receiptSchema = Type.Object({
  executionId: Type.String(),
  agentId: Type.String(),
  agent: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("done"),
    Type.Literal("failed"),
    Type.Literal("cancelled"),
  ]),
});

const resultSchema = Type.Object({
  ...receiptSchema.properties,
  error: Type.Union([Type.String(), Type.Null()]),
  response: Type.Array(Type.String()),
});

/** Model tools adapt the bot-messaging interface; addressing and exchange policy live there. */
export function coordinationExtension(
  agent: Agent,
  service: BotMessaging["Service"],
) {
  const messaging = botMessagingAccess(service);

  const delegate = defineTool({
    name: "delegate",
    description:
      "Start a bounded task with a permitted bot by ID. Returns a receipt immediately. For a question whose answer you need in this turn, use ask_bot instead. If the bot starts or messages a coding or desktop job for the task, the task stays pending until the job reports and the bot answers the report. A question the job asks may come to you first: answer it with answer_job_question from your brief, or tell the owner when only they can decide.",
    parameters: Type.Object({
      agentId: Type.String(),
      task: Type.String({ minLength: 1, maxLength: 32000 }),
    }),
    structuredOutputSchema: receiptSchema,
    replay: "safe",
    execute: async (args, api, context) =>
      toolOutput(
        await messaging.send(
          agent.id,
          {
            recipient: args.agentId,
            message: args.task,
            requestId: String(api.taskId),
          },
          context,
        ),
      ),
  });

  const status = defineTool({
    name: "delegation_status",
    description:
      "Read the status and completed answer of a bot message or task you sent. Other chat turns and private memory stay inaccessible. A task stays pending while jobs the bot started for it work, which can take long; its answer then includes the bot's reply to each job report, and a failed or stopped job fails the task. Optionally wait up to 60 seconds for the answer; if still pending, report that honestly instead of repeatedly checking.",
    parameters: Type.Object({
      executionId: Type.String(),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
    }),
    structuredOutputSchema: resultSchema,
    replay: "safe",
    execute: async (args, _api, context) =>
      toolOutput(
        await messaging.result(agent.id, args.executionId, {
          waitMs: (args.waitSeconds ?? 0) * 1000,
          context,
        }),
      ),
  });

  const list = defineTool({
    name: "list_bots",
    description:
      "List the enabled bots you may message, with their names, IDs, and descriptions. Use this to identify a bot named or @mentioned by the owner. Sending requires permission configured in your profile.",
    parameters: Type.Object({}),
    structuredOutputSchema: Type.Array(
      Type.Object({
        id: Type.String(),
        name: Type.String(),
        description: Type.String(),
      }),
    ),
    replay: "safe",
    execute: async () => toolOutput(messaging.recipients(agent.id)),
  });

  const ask = defineTool({
    name: "ask_bot",
    description:
      "Ask another permitted bot a question and wait up to 60 seconds for its answer, then relay it to the owner. recipient accepts a bot ID, exact name, or @Name (case insensitive). Send only the question and necessary context. If pending, keep its executionId for delegation_status; never invent an answer.",
    parameters: Type.Object({
      recipient: Type.String({ minLength: 1, maxLength: 100 }),
      message: Type.String({ minLength: 1, maxLength: 32000 }),
    }),
    structuredOutputSchema: resultSchema,
    replay: "safe",
    execute: async (args, api, context) => {
      context.abortSignal?.throwIfAborted();

      const sent = await messaging.send(
        agent.id,
        {
          recipient: args.recipient,
          message: args.message,
          requestId: String(api.taskId),
        },
        context,
      );

      return toolOutput(
        await messaging.result(agent.id, sent.executionId, {
          waitMs: 60000,
          context,
        }),
      );
    },
  });

  const answer = defineTool({
    name: "answer_job_question",
    description:
      "Answer a question that a job asked about a task you delegated; the job resumes with your answer. Answer only what your brief or knowledge settles; when the decision is the owner's, tell the owner instead. Fails when the owner already answered.",
    parameters: Type.Object({
      questionId: Type.String({ minLength: 1, maxLength: 200 }),
      answer: Type.String({ minLength: 1, maxLength: 32000 }),
    }),
    structuredOutputSchema: Type.Object({
      agentId: Type.String(),
      agent: Type.String(),
      job: Type.String(),
    }),
    // A rerun after the answer resumed the job would fail as already answered.
    replay: "unsafe",
    execute: async (args) =>
      toolOutput(
        await messaging.answerQuestion(agent.id, {
          questionId: args.questionId,
          answer: args.answer,
        }),
      ),
  });

  return defineExtension({
    name: "coordination",
    tools: agent.tools.includes("delegate")
      ? [delegate, status, list, ask, answer]
      : [],
  });
}

/** Offers bots with messaging the tools that reach other bots. */
export const coordinationTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const messaging = yield* BotMessaging;

    yield* (yield* BotExtensions).register(
      ExtensionPosition.coordination,
      (agent) => [coordinationExtension(agent, messaging)],
    );
  }),
);
