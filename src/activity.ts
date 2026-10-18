import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import type { Agent } from "./domain";
import type { BotCommunication, TranscriptMessage } from "./transcript";

export type ActivityKind =
  | "tool-call"
  | "tool-result"
  | "mcp-call"
  | "bot-message";

export type ActivityDetail = JsonValue | BotCommunication;

export type ActivityDetails = Record<string, ActivityDetail | undefined>;

export type OperationalActivity = {
  id: string;
  agentId: string;
  agentName: string;
  entryId: string;
  timestamp?: number;
  kind: ActivityKind;
  details: ActivityDetails;
};

const jsonValue: z.ZodType<JsonValue> = z.json();
const toolDetailsInput = z.object({ calls: z.unknown().optional() });

const nestedCallInput = z.object({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  args: z.unknown().optional(),
  status: z.unknown().optional(),
  durationMs: z.unknown().optional(),
  error: z.unknown().optional(),
});

const blockInput = z.object({
  type: z.unknown().optional(),
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  arguments: z.unknown().optional(),
  toolCallId: z.unknown().optional(),
  content: z.unknown().optional(),
  isError: z.unknown().optional(),
});

const isMcpTool = (name: string) => /^(mcp(?:[_:/-]|$))/i.test(name);

/** Converts durable transcript messages into the operational events shown in Activity. */
export function operationalActivity(
  agent: Pick<Agent, "id" | "name">,
  messages: TranscriptMessage[],
): OperationalActivity[] {
  const result: OperationalActivity[] = [];

  for (const message of messages) {
    const activity = (
      id: string,
      kind: ActivityKind,
      details: ActivityDetails,
    ): OperationalActivity => {
      const item: OperationalActivity = {
        id,
        agentId: agent.id,
        agentName: agent.name,
        entryId: message.entryId,
        kind,
        details,
      };

      if (message.timestamp !== undefined) item.timestamp = message.timestamp;

      return item;
    };

    if (message.kind === "bot-message" && message.communication) {
      const details = {
        content: message.content,
        communication: message.communication,
      } satisfies ActivityDetails;

      result.push(
        activity(
          `${agent.id}:${message.id}:bot-message`,
          "bot-message",
          details,
        ),
      );
    }

    if (message.role === "toolResult" || message.toolCallId) {
      const details = {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
        content: message.content || undefined,
      } satisfies ActivityDetails;

      result.push(
        activity(
          `${agent.id}:${message.id}:tool-result`,
          "tool-result",
          details,
        ),
      );
    }

    const toolDetails = toolDetailsInput.safeParse(message.toolDetails).data;
    const nested = z.array(z.unknown()).safeParse(toolDetails?.calls).data;

    if (nested)
      nested.forEach((rawCall, index) => {
        const call = nestedCallInput.safeParse(rawCall).data;

        if (!call) return;
        const name = z.string().safeParse(call.name).data;

        if (name === undefined) return;
        const callId = String(call.id ?? index);
        const args = z.string().safeParse(call.args).data;
        const status = z.string().safeParse(call.status).data;
        const durationMs = z.number().safeParse(call.durationMs).data;
        const error = z.string().safeParse(call.error).data;

        const details = {
          parentToolCallId: message.toolCallId,
          name,
          args,
          status,
          durationMs,
          error,
        } satisfies ActivityDetails;

        result.push(
          activity(
            `${agent.id}:${message.id}:nested-${callId}`,
            isMcpTool(name) ? "mcp-call" : "tool-call",
            details,
          ),
        );
      });

    const blocks = z.array(z.unknown()).safeParse(message.blocks).data;

    if (!blocks) continue;
    blocks.forEach((rawBlock, index) => {
      const block = blockInput.safeParse(rawBlock).data;
      const type = z.string().safeParse(block?.type).data;

      if (!block || !type) return;

      if (type === "toolCall") {
        const name = z.string().safeParse(block.name).data;

        if (name === undefined) return;
        const id = z.string().safeParse(block.id).data;

        const details = {
          id,
          name,
          arguments: jsonValue.safeParse(block.arguments).data,
        } satisfies ActivityDetails;

        result.push(
          activity(
            `${agent.id}:${message.id}:block-${index}`,
            isMcpTool(name) ? "mcp-call" : "tool-call",
            details,
          ),
        );
      } else if (type === "toolResult") {
        const toolCallId = z.string().safeParse(block.toolCallId).data;
        const isError = z.boolean().safeParse(block.isError).data;

        const details = {
          toolCallId,
          content: jsonValue.safeParse(block.content).data,
          isError,
        } satisfies ActivityDetails;

        result.push(
          activity(
            `${agent.id}:${message.id}:block-${index}`,
            "tool-result",
            details,
          ),
        );
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
