import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Agent } from "./domain";
import { delegationRequest, type CrumbleService } from "./service";

/** Delegated work runs in the target bot's chat and cannot delegate again. Private memory never crosses the boundary. */
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
        service.store
          .listExecutions(source.id)
          .some(
            (e) =>
              e.requestId.startsWith("delegate:") &&
              ["pending", "running"].includes(e.status),
          )
      )
        throw new Error("Delegated tasks cannot start further delegations");
      const target = service.agent(args.agentId);
      if (!target.enabled || target.id === source.id)
        throw new Error("Choose another enabled agent");
      const requestId = delegationRequest(source.id, String(api.taskId));
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
        const chat = await service.chat(target.id);
        execution = await service.send(chat.id, args.task, requestId);
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
      "Read the status and response of a task this agent delegated. The rest of that agent's chat and its private memory remain inaccessible.",
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
      const response = execution.submissionId
        ? await service.runtime.response(
            service.agent(execution.agentId),
            execution.conversationId,
            execution.submissionId,
          )
        : [];
      return {
        output: [
          {
            type: "text",
            text: JSON.stringify({
              status: execution.status,
              error: execution.error,
              response,
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
