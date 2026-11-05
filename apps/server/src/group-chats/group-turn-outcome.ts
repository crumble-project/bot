import type { Conversation } from "@earendil-works/pi-durable";
import type { AgentRuntime } from "../bots/runtime";
import {
  PASS_TOOL_NAME,
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../contract/tools";
import { webPagesDetails } from "../contract/tool-details";
import type { WebSource } from "../contract/web-search";
import type { Agent } from "../contract/agents";
import { contentText } from "../transcript/entries";
import {
  isToolResult,
  reactionOf,
  toolResult,
} from "../transcript/tool-results";
import { turnMessages, type ModelMessage } from "../transcript/transcript";

export type TurnOutcome =
  | { kind: "message"; text: string; sources: WebSource[] }
  | { kind: "reaction"; emoji: string }
  | { kind: "pass" };

function toolOutcome(message: ModelMessage): TurnOutcome | null {
  if (isToolResult(message, PASS_TOOL_NAME)) return { kind: "pass" };

  const emoji = reactionOf(message);

  return emoji ? { kind: "reaction", emoji } : null;
}

/** The pages a turn's web searches and page reads returned, once each and without the ones that failed. */
function webSourcesOf(messages: ModelMessage[]): WebSource[] {
  const sources = new Map<string, WebSource>();

  for (const message of messages)
    for (const toolName of [WEB_SEARCH_TOOL_NAME, WEB_EXTRACT_TOOL_NAME])
      for (const page of toolResult(message, toolName, webPagesDetails) ?? [])
        if ("title" in page) sources.set(page.url, page);

  return [...sources.values()];
}

/** A group turn's result after its input: a pass or reaction wins, else the final answer, else nothing. */
async function readTurnOutcome(
  conversation: Conversation,
  inputEntryId: number,
): Promise<TurnOutcome> {
  const messages = await turnMessages(conversation, inputEntryId);
  let text = "";

  for (const message of messages) {
    if (message.role === "assistant")
      text = contentText(message.content).trim();
    const outcome = toolOutcome(message);

    if (outcome) return outcome;
  }

  return text
    ? { kind: "message", text, sources: webSourcesOf(messages) }
    : { kind: "pass" };
}

/** What a settled group turn leaves for the group: its final answer, a reaction, or nothing. */
export async function turnOutcome(
  runtime: Pick<AgentRuntime, "settledTurn">,
  agent: Agent,
  conversationId: string,
  submissionId: string,
): Promise<TurnOutcome> {
  const turn = await runtime.settledTurn(agent, conversationId, submissionId);

  return turn
    ? readTurnOutcome(turn.conversation, turn.entry)
    : { kind: "pass" };
}
