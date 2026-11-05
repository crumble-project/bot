import { z } from "zod";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { contentText } from "../bots/entries";
import { reactionOf } from "../bots/reaction";
import type { AgentRuntime } from "../bots/runtime";
import {
  entriesFrom,
  isInputEntry,
  toolMetadata,
  type ModelMessage,
} from "../bots/transcript";
import {
  PASS_TOOL_NAME,
  WEB_EXTRACT_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
} from "../contract/tools";
import type { WebSource } from "../contract/web-search";
import type { Agent } from "../shared/domain";

export type TurnOutcome =
  | { kind: "message"; text: string; sources: WebSource[] }
  | { kind: "reaction"; emoji: string }
  | { kind: "pass" };

function toolOutcome(message: ModelMessage): TurnOutcome | null {
  const { toolName, isError, details } = toolMetadata.parse(message);

  if (message.role !== "toolResult" || isError) return null;

  if (toolName === PASS_TOOL_NAME) return { kind: "pass" };

  const emoji = reactionOf({
    role: message.role,
    toolName,
    isError,
    toolDetails: details,
  });

  return emoji ? { kind: "reaction", emoji } : null;
}

const pages = z.array(
  z.object({
    url: z.string(),
    title: z.string().catch(""),
    error: z.unknown().optional(),
  }),
);

function isWebResult(message: ModelMessage) {
  const { toolName, isError } = toolMetadata.parse(message);

  return (
    message.role === "toolResult" &&
    !isError &&
    (toolName === WEB_SEARCH_TOOL_NAME || toolName === WEB_EXTRACT_TOOL_NAME)
  );
}

/** The pages a turn's web searches and page reads returned, once each and without the ones that failed. */
function webSourcesOf(messages: ModelMessage[]): WebSource[] {
  const sources = new Map<string, WebSource>();

  for (const message of messages.filter(isWebResult))
    for (const { url, title, error } of pages.safeParse(
      toolMetadata.parse(message).details,
    ).data ?? [])
      if (error === undefined) sources.set(url, { url, title });

  return [...sources.values()];
}

/** The model messages after a turn's input, up to the next input. */
function turnMessages(entries: readonly EntryRecord[]) {
  const end = entries.findIndex((entry) => isInputEntry(entry));

  return (end === -1 ? entries : entries.slice(0, end)).flatMap(
    (entry) => entry.model ?? [],
  );
}

/** A group turn's result after its input: a pass or reaction wins, else the final answer, else nothing. */
async function readTurnOutcome(
  conversation: Conversation,
  inputEntryId: number,
): Promise<TurnOutcome> {
  const messages = turnMessages(
    await entriesFrom(conversation, inputEntryId + 1),
  );

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
