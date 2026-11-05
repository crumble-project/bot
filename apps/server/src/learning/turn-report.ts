import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { Agent } from "../shared/domain";
import { clip } from "../shared/limits";
import { contentText, inputMetadata, type ModelContent } from "../bots/entries";
import type { AgentRuntime } from "../bots/runtime";
import {
  entriesBefore,
  entriesFrom,
  isInputEntry,
  record,
  toolMetadata,
  type ModelMessage,
} from "../bots/transcript";
import { MEMORY_TOOL_NAME, SKILL_MANAGE_TOOL_NAME } from "../contract/tools";
import { MEMORY_WRITE_ACTIONS } from "../memory/memory-tool";

export type TurnReport = {
  /** Assistant messages that called tools: the turn's tool-activity rounds. */
  rounds: number;
  /** Rounds after the turn's last skill write, or null when it wrote none. */
  roundsSinceSkillWrite: number | null;
  /** Rounds after the turn's last memory write, or null when it wrote none. */
  roundsSinceMemoryWrite: number | null;
  /** The turn in plain text for a review, preceded by the chat before it, bounded by `maxChars`. */
  digest: string;
};

const CONTEXT_ENTRIES = 40;

const memoryWriteCall = z.object({ action: z.enum(MEMORY_WRITE_ACTIONS) });

type ToolCall = Extract<
  Extract<ModelContent, unknown[]>[number],
  { type: "toolCall" }
>;

function recordToolRound(calls: ToolCall[], counters: TurnReport): void {
  counters.rounds++;

  if (counters.roundsSinceSkillWrite !== null) counters.roundsSinceSkillWrite++;

  if (counters.roundsSinceMemoryWrite !== null)
    counters.roundsSinceMemoryWrite++;

  for (const call of calls) {
    if (call.name === SKILL_MANAGE_TOOL_NAME)
      counters.roundsSinceSkillWrite = 0;

    const memoryWrite = memoryWriteCall.safeParse(call.arguments);

    if (call.name === MEMORY_TOOL_NAME && memoryWrite.success)
      counters.roundsSinceMemoryWrite = 0;
  }
}

function assistantLines(
  content: ModelContent,
  counters?: TurnReport,
): string[] {
  const lines: string[] = [];
  const text = contentText(content).trim();

  if (text) lines.push(`Assistant:\n${text}`);

  const calls = Array.isArray(content)
    ? content.filter((block) => block?.type === "toolCall")
    : [];

  if (calls.length && counters) recordToolRound(calls, counters);

  for (const call of calls)
    lines.push(
      `Tool call ${String(call.name ?? "unknown")}: ${clip(JSON.stringify(call.arguments ?? {}), 2000)}`,
    );

  return lines;
}

function toolResultLine(message: ModelMessage): string {
  const { toolName, isError } = toolMetadata.parse(message);

  return `${isError ? "Tool error" : "Tool result"} ${toolName ?? "unknown"}: ${clip(contentText(message.content).trim(), 4000)}`;
}

function messageLines(
  message: ModelMessage,
  counters: TurnReport | undefined,
): string[] {
  if (message.role === "assistant")
    return assistantLines(message.content, counters);

  if (message.role === "toolResult") return [toolResultLine(message)];

  if (message.role !== "user") return [];
  const text = contentText(message.content).trim();

  return text ? [`Owner:\n${text}`] : [];
}

function entryLines(entry: EntryRecord, counters?: TurnReport): string[] {
  if (isInputEntry(entry)) {
    const input = inputMetadata.parse(record(entry.data) ?? {});

    return [`Owner:\n${input.text ?? contentText(entry.model?.[0]?.content)}`];
  }

  return (entry.model ?? []).flatMap((message) =>
    messageLines(message, counters),
  );
}

function clipTurn(turn: string, maxChars: number) {
  if (turn.length <= maxChars) return turn;

  // Keep the input and the end of the turn; the middle is usually tool output.
  const head = Math.floor(maxChars * 0.4);
  const tail = maxChars - head - 24;

  return `${turn.slice(0, head)}\n\n[… omitted for length …]\n\n${turn.slice(-tail)}`;
}

async function earlierChat(
  conversation: Conversation,
  inputEntryId: number,
  room: number,
) {
  const earlier = await entriesBefore(
    conversation,
    inputEntryId,
    CONTEXT_ENTRIES,
  );

  const contextLines = [...earlier]
    .reverse()
    .filter((entry) => isInputEntry(entry) || entry.model?.length)
    .flatMap((entry) => entryLines(entry));

  const context = contextLines.join("\n\n");

  return context.length > room
    ? `[… earlier chat omitted …]\n\n${context.slice(-room)}`
    : context;
}

/**
 * What a review needs to know about one turn: the turn itself in full, preceded by the chat before it for the
 * referents of corrections such as "use the previous format". The earlier chat gives way first when `maxChars`
 * binds, then the middle of the turn.
 */
async function readTurnReport(
  conversation: Conversation,
  inputEntryId: number,
  maxChars: number,
): Promise<TurnReport> {
  // The turn is the input entry and everything up to the next input.
  const turnEntries = await entriesFrom(conversation, inputEntryId);

  const report: TurnReport = {
    rounds: 0,
    roundsSinceSkillWrite: null,
    roundsSinceMemoryWrite: null,
    digest: "",
  };

  const turnLines: string[] = [];

  for (const [index, entry] of turnEntries.entries()) {
    if (index > 0 && isInputEntry(entry)) break;
    turnLines.push(...entryLines(entry, index > 0 ? report : undefined));
  }

  const turn = clipTurn(turnLines.join("\n\n"), maxChars);
  const room = maxChars - turn.length - 40;

  const context =
    room > 200 && inputEntryId > 1
      ? await earlierChat(conversation, inputEntryId, room)
      : "";

  report.digest = context
    ? `Earlier chat:\n\n${context}\n\nThe turn to review:\n\n${turn}`
    : `The turn to review:\n\n${turn}`;

  return report;
}

/**
 * The characters of model input a whole review may spend, across every request it makes: 75% of the review model's
 * context window, at most 600,000 tokens, lowered to the configured cap; four characters stand for a token.
 */
export function reviewBudgetChars(
  contextWindow: number | undefined,
  agent: Pick<Agent, "review">,
) {
  const ceiling = contextWindow
    ? Math.min(contextWindow * 0.75, 600000)
    : 120000;

  return Math.min(agent.review?.maxInputTokens ?? ceiling, ceiling) * 4;
}

/** A settled turn's tool-activity rounds and a bounded plain-text digest for its review. */
export async function turnReport(
  runtime: Pick<AgentRuntime, "settledTurn">,
  agent: Agent,
  conversationId: string,
  submissionId: string,
  maxChars: number,
): Promise<TurnReport> {
  const turn = await runtime.settledTurn(agent, conversationId, submissionId);

  if (!turn)
    return {
      rounds: 0,
      roundsSinceSkillWrite: null,
      roundsSinceMemoryWrite: null,
      digest: "",
    };

  return readTurnReport(turn.conversation, turn.entry, maxChars);
}
