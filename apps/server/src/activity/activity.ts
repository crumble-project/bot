import type { JsonValue } from "@earendil-works/chord";
import { z } from "zod";
import type { BotCommunication } from "../contract/api-responses";
import type { ACTIVITY_KINDS } from "../shared/domain";
import type { Agent } from "../contract/agents";
import type { LearnedChange } from "../contract/skills";
import {
  toolBlocks,
  type TranscriptMessage,
  type TranscriptPage,
} from "../transcript/transcript";
import { isMcpTool } from "../contract/tools";
import { parseEntryId } from "../shared/entry-ids";

export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

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

const toolDetailsInput = z.object({ calls: z.unknown().optional() });

const nestedCallInput = z.object({
  id: z.unknown().optional(),
  name: z.unknown().optional(),
  args: z.unknown().optional(),
  status: z.unknown().optional(),
  durationMs: z.unknown().optional(),
  error: z.unknown().optional(),
});

type ActivityAgent = Pick<Agent, "id" | "name">;

function activityOf(
  agent: ActivityAgent,
  message: TranscriptMessage,
  id: string,
  kind: ActivityKind,
  details: ActivityDetails,
): OperationalActivity {
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
}

function messageEvents(
  agent: ActivityAgent,
  message: TranscriptMessage,
): OperationalActivity[] {
  const result: OperationalActivity[] = [];

  if (message.kind === "bot-message" && message.communication) {
    const details = {
      content: message.content,
      communication: message.communication,
    } satisfies ActivityDetails;

    result.push(
      activityOf(
        agent,
        message,
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
      activityOf(
        agent,
        message,
        `${agent.id}:${message.id}:tool-result`,
        "tool-result",
        details,
      ),
    );
  }

  return result;
}

function nestedCallEvent(
  agent: ActivityAgent,
  message: TranscriptMessage,
  call: z.infer<typeof nestedCallInput>,
  index: number,
): OperationalActivity[] {
  const name = z.string().safeParse(call.name).data;

  if (name === undefined) return [];

  const callId = String(
    z.union([z.string(), z.number()]).safeParse(call.id).data ?? index,
  );

  const details = {
    parentToolCallId: message.toolCallId,
    name,
    args: z.string().safeParse(call.args).data,
    status: z.string().safeParse(call.status).data,
    durationMs: z.number().safeParse(call.durationMs).data,
    error: z.string().safeParse(call.error).data,
  } satisfies ActivityDetails;

  return [
    activityOf(
      agent,
      message,
      `${agent.id}:${message.id}:nested-${callId}`,
      isMcpTool(name) ? "mcp-call" : "tool-call",
      details,
    ),
  ];
}

function nestedCallEvents(agent: ActivityAgent, message: TranscriptMessage) {
  const toolDetails = toolDetailsInput.safeParse(message.toolDetails).data;
  const nested = z.array(z.unknown()).safeParse(toolDetails?.calls).data;

  return (nested ?? []).flatMap((rawCall, index) => {
    const call = nestedCallInput.safeParse(rawCall).data;

    return call ? nestedCallEvent(agent, message, call, index) : [];
  });
}

function blockEvents(
  agent: ActivityAgent,
  message: TranscriptMessage,
): OperationalActivity[] {
  return toolBlocks(message).flatMap((block) => {
    const id = `${agent.id}:${message.id}:block-${block.index}`;

    if (block.type === "toolResult") {
      const details = {
        toolCallId: block.toolCallId,
        content: block.content,
        isError: block.isError,
      } satisfies ActivityDetails;

      return [activityOf(agent, message, id, "tool-result", details)];
    }

    const { name } = block;

    if (name === undefined) return [];

    const details = {
      id: block.id,
      name,
      arguments: block.arguments,
    } satisfies ActivityDetails;

    return [
      activityOf(
        agent,
        message,
        id,
        isMcpTool(name) ? "mcp-call" : "tool-call",
        details,
      ),
    ];
  });
}

export function operationalActivity(
  agent: ActivityAgent,
  messages: TranscriptMessage[],
): OperationalActivity[] {
  return messages.flatMap((message) => [
    ...messageEvents(agent, message),
    ...nestedCallEvents(agent, message),
    ...blockEvents(agent, message),
  ]);
}

export type ChangeActivity = {
  id: string;
  agentId: string | null;
  agentName: string | null;
  timestamp: number;
  kind: "change";
  change: LearnedChange;
};

export type FeedItem = OperationalActivity | ChangeActivity;

type Key = { t: number; e: number; id: string };

const entryNumber = (entryId: string) => parseEntryId(entryId) || 0;

function keyOf(item: FeedItem): Key {
  return {
    t: item.timestamp ?? 0,
    e: item.kind === "change" ? 0 : entryNumber(item.entryId),
    id: item.id,
  };
}

function compareKeys(a: Key, b: Key) {
  return a.t - b.t || a.e - b.e || a.id.localeCompare(b.id);
}

const cursorInput = z.object({
  k: z.object({ t: z.number(), e: z.number(), id: z.string() }).nullable(),
  h: z.record(z.string(), z.union([z.string(), z.null(), z.literal(false)])),
  c: z.string().nullable(),
});

type Cursor = z.infer<typeof cursorInput>;

export function decodeCursor(value: string): Cursor | null {
  try {
    return cursorInput.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

const encodeCursor = (cursor: Cursor) =>
  Buffer.from(JSON.stringify(cursor)).toString("base64url");

const HISTORY_PAGES = 5;
const HISTORY_PAGE_SIZE = 200;

type ActivityPageOptions<A extends Pick<Agent, "id" | "name">> = {
  agents: A[];
  history: (
    agent: A,
    before: string | undefined,
    limit: number,
  ) => Promise<TranscriptPage>;
  changes: (limit: number, before: string | undefined) => LearnedChange[];
  agentName: (id: string) => string | null;
  limit: number;
  cursor: Cursor | null;
  kind?: FeedItem["kind"] | undefined;
};

type ActivityQueue = { items: FeedItem[]; tags: (string | null)[] };

function oldestMessageKey(messages: TranscriptMessage[]) {
  return messages.reduce<Key | null>((min, message) => {
    const key = {
      t: message.timestamp ?? 0,
      e: entryNumber(message.entryId),
      id: "",
    };

    return !min || compareKeys(key, min) < 0 ? key : min;
  }, null);
}

function isFreshActivity(
  item: OperationalActivity,
  kind: ActivityPageOptions<ActivityAgent>["kind"],
  cursor: Cursor | null,
) {
  return (
    (!kind || item.kind === kind) &&
    (!cursor?.k || compareKeys(keyOf(item), cursor.k) < 0)
  );
}

function sortedQueue(items: FeedItem[], tags: (string | null)[]) {
  const order = items
    .map((item, index) => ({ item, tag: tags[index]! }))
    .sort((a, b) => compareKeys(keyOf(b.item), keyOf(a.item)));

  return {
    items: order.map(({ item }) => item),
    tags: order.map(({ tag }) => tag),
  };
}

async function readTranscriptPages<A extends Pick<Agent, "id" | "name">>(
  agent: A,
  start: string | null | undefined,
  options: ActivityPageOptions<A>,
) {
  const { limit, cursor, kind } = options;
  let before = start ?? undefined;
  const items: FeedItem[] = [];
  const tags: (string | null)[] = [];
  let page: TranscriptPage | null = null;

  for (let index = 0; index < HISTORY_PAGES; index++) {
    page = await options.history(agent, before, HISTORY_PAGE_SIZE);

    const fresh = operationalActivity(agent, page.messages).filter((item) =>
      isFreshActivity(item, kind, cursor),
    );

    items.push(...fresh);
    tags.push(...fresh.map(() => before ?? null));

    if (!page.hasMore || !page.oldestEntryId || items.length >= limit) break;
    before = page.oldestEntryId;
  }

  return { items, tags, page };
}

async function agentActivityQueue<A extends Pick<Agent, "id" | "name">>(
  agent: A,
  start: string | null | undefined,
  options: ActivityPageOptions<A>,
) {
  const { items, tags, page } = await readTranscriptPages(
    agent,
    start,
    options,
  );

  const more = Boolean(page?.hasMore && page.oldestEntryId);
  const floor = more && page ? oldestMessageKey(page.messages) : null;

  const queue = sortedQueue(items, tags);

  return { queue, floor, next: more ? page!.oldestEntryId! : (false as const) };
}

function newestQueueHead(all: FeedItem[][], heads: number[]) {
  let best = -1;

  for (let index = 0; index < all.length; index++) {
    const item = all[index]![heads[index]!];

    if (
      item &&
      (best < 0 ||
        compareKeys(keyOf(item), keyOf(all[best]![heads[best]!]!)) > 0)
    )
      best = index;
  }

  return best;
}

function mergeActivityQueues(
  all: FeedItem[][],
  limit: number,
  floor: Key | null,
) {
  const heads = all.map(() => 0);
  const activities: FeedItem[] = [];

  while (activities.length < limit) {
    const best = newestQueueHead(all, heads);

    if (best < 0) break;
    const item = all[best]![heads[best]!]!;

    if (floor && compareKeys(keyOf(item), floor) <= 0) break;
    activities.push(item);
    heads[best]!++;
  }

  return { heads, activities };
}

type FetchedQueue = { agentId: string; queue: number; next: string | false };

async function loadAgentQueues<A extends Pick<Agent, "id" | "name">>(
  options: ActivityPageOptions<A>,
) {
  const { cursor, kind } = options;
  const queues: ActivityQueue[] = [];
  const hints: Cursor["h"] = {};
  const fetched: FetchedQueue[] = [];
  let floor: Key | null = null;

  for (const agent of kind === "change" ? [] : options.agents) {
    const start = cursor ? cursor.h[agent.id] : null;

    if (start === false) {
      hints[agent.id] = false;
      continue;
    }

    const loaded = await agentActivityQueue(agent, start, options);

    if (loaded.floor && (!floor || compareKeys(loaded.floor, floor) > 0))
      floor = loaded.floor;
    queues.push(loaded.queue);

    fetched.push({
      agentId: agent.id,
      queue: queues.length - 1,
      next: loaded.next,
    });
  }

  return { queues, hints, fetched, floor };
}

function changeFeedQueue<A extends Pick<Agent, "id" | "name">>(
  options: ActivityPageOptions<A>,
): FeedItem[] {
  const { limit, cursor, kind } = options;

  if (kind && kind !== "change") return [];

  return options.changes(limit + 1, cursor?.c ?? undefined).map((change) => ({
    id: change.id,
    agentId: change.agentId,
    agentName: change.agentId ? options.agentName(change.agentId) : null,
    timestamp: Date.parse(change.createdAt),
    kind: "change",
    change,
  }));
}

function nextCursor(
  activities: FeedItem[],
  hints: Cursor["h"],
  cursor: Cursor | null | undefined,
): Cursor {
  const lastChange = activities.findLast((item) => item.kind === "change");
  const last = activities.at(-1);

  return {
    k: last ? keyOf(last) : (cursor?.k ?? null),
    h: hints,
    c: lastChange?.id ?? cursor?.c ?? null,
  };
}

export async function activityPage<A extends Pick<Agent, "id" | "name">>(
  options: ActivityPageOptions<A>,
) {
  const { limit, cursor } = options;
  const { queues, hints, fetched, floor } = await loadAgentQueues(options);
  const changeQueue = changeFeedQueue(options);
  const all = [...queues.map((queue) => queue.items), changeQueue];
  const { heads, activities } = mergeActivityQueues(all, limit, floor);

  for (const { agentId, queue, next } of fetched) {
    const head = heads[queue]!;
    const { items, tags } = queues[queue]!;

    hints[agentId] = head < items.length ? tags[head]! : next;
  }

  const hasMore =
    Object.values(hints).some((hint) => hint !== false) ||
    heads.at(-1)! < changeQueue.length;

  return {
    activities,
    hasMore,
    nextCursor: hasMore
      ? encodeCursor(nextCursor(activities, hints, cursor))
      : null,
  };
}
