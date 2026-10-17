import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "./domain";
import { conversationReference } from "./runtime";
import type { CrumbleService } from "./service";

/** A delegated session cannot delegate again. Private memory never crosses the boundary. */
export function coordinationExtension(agent: Agent, service: CrumbleService) {
  const delegate = defineTool({
    name: "delegate",
    description:
      "Give a bounded task to an explicitly permitted agent. Returns an execution receipt; use delegation_status to check its response. Share only the context required for this task.",
    parameters: Type.Object({
      agentId: Type.String(),
      task: Type.String({ minLength: 1, maxLength: 32000 }),
    }),
    replay: "safe",
    execute: async (args, api) => {
      const source = service.agent(agent.id);
      if (
        !source.tools.includes("delegate") ||
        !source.delegates.includes(args.agentId)
      )
        throw new Error(
          "This agent has no permission to delegate to that agent",
        );
      if (
        service.store.getSetting(
          `delegation:${conversationReference(source.id, Number(api.conversationId))}`,
        )
      )
        throw new Error("Delegated tasks cannot start further delegations");
      const target = service.agent(args.agentId);
      if (!target.enabled || target.id === source.id)
        throw new Error("Choose another enabled agent");
      const requestId = `delegate:${source.id}:${api.taskId}`;
      let execution = service.store
        .listExecutions(target.id)
        .find((e) => e.requestId === requestId);
      if (!execution) {
        const active = service.store
          .listExecutions(target.id)
          .filter((e) => ["pending", "running"].includes(e.status));
        if (active.length >= 4)
          throw new Error(
            "This agent already has four active tasks; try again later",
          );
        const key = `delegation-session:${source.id}:${api.taskId}`;
        let conversationId = service.store.getSetting<string>(key);
        if (!conversationId) {
          conversationId = (
            await service.createConversation(target.id, `From ${source.name}`)
          ).id;
          service.store.setSetting(key, conversationId);
          service.store.setSetting(`delegation:${conversationId}`, {
            sourceAgentId: source.id,
          });
        }
        execution = await service.send(conversationId, args.task, requestId);
      }
      service.store.setSetting(`delegation-receipt:${execution.id}`, {
        sourceAgentId: source.id,
        targetAgentId: target.id,
      });
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({
              executionId: execution.id,
              agent: target.name,
              status: execution.status,
            }),
          },
        ],
      };
    },
  });
  const status = defineTool({
    name: "delegation_status",
    description:
      "Read the status and response of a task this agent delegated. Other conversations and private memory remain inaccessible.",
    parameters: Type.Object({ executionId: Type.String() }),
    replay: "safe",
    execute: async (args) => {
      const receipt = service.store.getSetting<{
        sourceAgentId: string;
        targetAgentId: string;
      }>(`delegation-receipt:${args.executionId}`);
      const source = service.agent(agent.id);
      if (
        !source.tools.includes("delegate") ||
        receipt?.sourceAgentId !== source.id ||
        !source.delegates.includes(receipt.targetAgentId)
      )
        throw new Error("Delegation receipt not found");
      const execution = service.store.getExecution(args.executionId);
      if (!execution) throw new Error("Delegation execution not found");
      const snapshot = await service.runtime.snapshot(
        service.agent(execution.agentId),
        execution.conversationId,
      );
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({
              status: execution.status,
              error: execution.error,
              response: snapshot.messages.filter(
                (message) => message.role === "assistant",
              ),
            }),
          },
        ],
      };
    },
  });
  return defineExtension({
    name: "coordination",
    tools: agent.tools.includes("delegate") ? [delegate, status] : [],
  });
}
