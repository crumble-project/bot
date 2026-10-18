import type { Agent } from "./domain";
import type { TranscriptMessage } from "./transcript";

export type ActivityKind =
  "tool-call" | "tool-result" | "mcp-call" | "bot-message";

export type OperationalActivity = {
  id: string;
  agentId: string;
  agentName: string;
  entryId: string;
  timestamp?: number;
  kind: ActivityKind;
  details: Record<string, unknown>;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const isMcpTool = (name: string) => /^(mcp(?:[_:/-]|$))/i.test(name);

/** Converts durable transcript messages into the operational events shown in Activity. */
export function operationalActivity(
  agent: Pick<Agent, "id" | "name">,
  messages: TranscriptMessage[],
): OperationalActivity[] {
  const result: OperationalActivity[] = [];
  for (const message of messages) {
    if (message.kind === "bot-message" && message.communication) {
      result.push({
        id: `${agent.id}:${message.id}:bot-message`,
        agentId: agent.id,
        agentName: agent.name,
        entryId: message.entryId,
        ...(message.timestamp === undefined
          ? {}
          : { timestamp: message.timestamp }),
        kind: "bot-message",
        details: {
          content: message.content,
          communication: message.communication,
        },
      });
    }
    if (message.role === "toolResult" || message.toolCallId) {
      result.push({
        id: `${agent.id}:${message.id}:tool-result`,
        agentId: agent.id,
        agentName: agent.name,
        entryId: message.entryId,
        ...(message.timestamp === undefined
          ? {}
          : { timestamp: message.timestamp }),
        kind: "tool-result",
        details: {
          ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
          ...(message.toolName ? { toolName: message.toolName } : {}),
          ...(message.isError === undefined
            ? {}
            : { isError: message.isError }),
          ...(message.content ? { content: message.content } : {}),
        },
      });
    }
    const nested = object(message.toolDetails)?.calls;
    if (Array.isArray(nested))
      nested.forEach((rawCall, index) => {
        const call = object(rawCall);
        if (!call || typeof call.name !== "string") return;
        const callId = String(call.id ?? index);
        result.push({
          id: `${agent.id}:${message.id}:nested-${callId}`,
          agentId: agent.id,
          agentName: agent.name,
          entryId: message.entryId,
          ...(message.timestamp === undefined
            ? {}
            : { timestamp: message.timestamp }),
          kind: isMcpTool(call.name) ? "mcp-call" : "tool-call",
          details: {
            parentToolCallId: message.toolCallId,
            name: call.name,
            ...(typeof call.args === "string" ? { args: call.args } : {}),
            ...(typeof call.status === "string" ? { status: call.status } : {}),
            ...(typeof call.durationMs === "number"
              ? { durationMs: call.durationMs }
              : {}),
            ...(typeof call.error === "string" ? { error: call.error } : {}),
          },
        });
      });
    if (!Array.isArray(message.blocks)) continue;
    message.blocks.forEach((rawBlock, index) => {
      const block = object(rawBlock);
      if (!block || typeof block.type !== "string") return;
      if (block.type === "toolCall" && typeof block.name === "string") {
        const kind = isMcpTool(block.name) ? "mcp-call" : "tool-call";
        result.push({
          id: `${agent.id}:${message.id}:block-${index}`,
          agentId: agent.id,
          agentName: agent.name,
          entryId: message.entryId,
          ...(message.timestamp === undefined
            ? {}
            : { timestamp: message.timestamp }),
          kind,
          details: {
            ...(typeof block.id === "string" ? { id: block.id } : {}),
            name: block.name,
            ...(block.arguments === undefined
              ? {}
              : { arguments: block.arguments }),
          },
        });
      } else if (block.type === "toolResult") {
        result.push({
          id: `${agent.id}:${message.id}:block-${index}`,
          agentId: agent.id,
          agentName: agent.name,
          entryId: message.entryId,
          ...(message.timestamp === undefined
            ? {}
            : { timestamp: message.timestamp }),
          kind: "tool-result",
          details: {
            ...(typeof block.toolCallId === "string"
              ? { toolCallId: block.toolCallId }
              : {}),
            ...(block.content === undefined ? {} : { content: block.content }),
            ...(typeof block.isError === "boolean"
              ? { isError: block.isError }
              : {}),
          },
        });
      }
    });
  }
  return result;
}

export function sortActivity(items: OperationalActivity[]) {
  return items.sort((a, b) => {
    const timestamp = (b.timestamp ?? 0) - (a.timestamp ?? 0);
    if (timestamp) return timestamp;
    const entry = (id: string) =>
      Number(id.slice(id.lastIndexOf(":") + 1)) || 0;
    return entry(b.entryId) - entry(a.entryId) || b.id.localeCompare(a.id);
  });
}
