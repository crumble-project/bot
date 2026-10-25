import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "../shared/domain";
import { botMessagingAccess, type BotMessaging } from "./bot-messaging";

const output = (value: JsonValue) => ({
  structuredOutput: value,
  output: [{ type: "text" as const, text: JSON.stringify(value) }],
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
      "Start a bounded task with a permitted bot by ID. Returns a receipt immediately. For a question whose answer you need in this turn, use ask_bot instead.",
    parameters: Type.Object({
      agentId: Type.String(),
      task: Type.String({ minLength: 1, maxLength: 32000 }),
    }),
    replay: "safe",
    execute: async (args, api, context) =>
      output(
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
      "Read the status and completed answer of a bot message or task you sent. Other chat turns and private memory stay inaccessible. Optionally wait up to 60 seconds for the answer; if still pending, report that honestly instead of repeatedly checking.",
    parameters: Type.Object({
      executionId: Type.String(),
      waitSeconds: Type.Optional(Type.Integer({ minimum: 0, maximum: 60 })),
    }),
    replay: "safe",
    execute: async (args, _api, context) =>
      output(
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
    replay: "safe",
    execute: async () => output(messaging.recipients(agent.id)),
  });

  const ask = defineTool({
    name: "ask_bot",
    description:
      "Ask another permitted bot a question and wait up to 60 seconds for its answer, then relay it to the owner. recipient accepts a bot ID, exact name, or @Name (case insensitive). Send only the question and necessary context. If pending, keep its executionId for delegation_status; never invent an answer.",
    parameters: Type.Object({
      recipient: Type.String({ minLength: 1, maxLength: 100 }),
      message: Type.String({ minLength: 1, maxLength: 32000 }),
    }),
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

      return output(
        await messaging.result(agent.id, sent.executionId, {
          waitMs: 60000,
          context,
        }),
      );
    },
  });

  return defineExtension({
    name: "coordination",
    tools: agent.tools.includes("delegate")
      ? [delegate, status, list, ask]
      : [],
  });
}
