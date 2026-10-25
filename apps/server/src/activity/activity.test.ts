import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createModels, Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentRuntime } from "../bots/runtime";
import { CrumbleService } from "../bots/service";
import { Scheduler } from "../schedules/scheduler";
import { Store } from "../shared/store";
import { createAPI } from "../app/api";
import {
  activityPage,
  decodeCursor,
  operationalActivity,
  sortActivity,
} from "./activity";
import type { LearnedChange } from "../shared/domain";
import type { TranscriptMessage } from "../bots/transcript";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("operational activity", () => {
  test("serves real durable tool calls and results through the authenticated feed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bot-activity-api-"));
    dirs.push(dir);
    const faux = fauxProvider({ provider: "faux", models: [{ id: "chat" }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("lookup", { value: "x" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("complete"),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);

    const lookup = defineTool({
      name: "lookup",
      description: "Lookup",
      parameters: Type.Object({ value: Type.String() }),
      execute: async () => ({
        output: [{ type: "text" as const, text: "found" }],
      }),
    });

    const store = new Store(dir);

    const service = new CrumbleService(
      store,
      new AgentRuntime(dir, {
        models,
        extensions: () => [
          defineExtension({ name: "lookup", tools: [lookup] }),
        ],
      }),
    );

    const scheduler = new Scheduler(
      store,
      (agent, prompt, requestId, scheduleId) =>
        service.dispatch(agent, prompt, requestId, scheduleId),
    );

    const token = "t".repeat(40);
    const app = createAPI(service, scheduler, token);

    const agent = store.createAgent({
      name: "Helper",
      avatar: "bot",
      description: "",
      instructions: "Use lookup",
      provider: "faux",
      model: "chat",
      enabled: true,
      tools: [],
      skills: [],
      mcpServers: [],
      delegates: [],
    });

    const execution = await service.sendChat(
      agent.id,
      "find x",
      "00000000-0000-4000-8000-000000000001",
    );

    await service.runtime.wait(execution.submissionId!, agent);

    const response = await app.request("/v1/activity/feed", {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.activities.map((item: any) => item.kind)).toEqual([
      "tool-result",
      "tool-call",
    ]);
    expect(body.activities[0].details).toMatchObject({
      toolName: "lookup",
      content: "found",
    });
    await service.close();
  });

  test("keeps tool, MCP, and bot communication events while hiding ordinary text", () => {
    const result = operationalActivity({ id: "agent-1", name: "Helper" }, [
      {
        id: "agent-1:4:0",
        entryId: "agent-1:4",
        role: "assistant",
        content: "final answer",
        timestamp: 40,
        blocks: [{ type: "text", text: "final answer" }],
      },
      {
        id: "agent-1:3:0",
        entryId: "agent-1:3",
        role: "assistant",
        content: "Tool call: search",
        timestamp: 30,
        blocks: [
          {
            type: "toolCall",
            id: "call-1",
            name: "search",
            arguments: { q: "cats" },
          },
          {
            type: "toolCall",
            id: "call-2",
            name: "mcp__github__issues",
            arguments: { repo: "x" },
          },
        ],
      },
      {
        id: "agent-1:2:0",
        entryId: "agent-1:2",
        role: "toolResult",
        content: "result",
        timestamp: 20,
        toolCallId: "call-1",
        toolName: "search",
        isError: false,
      },
      {
        id: "agent-1:1:0",
        entryId: "agent-1:1",
        role: "event",
        kind: "bot-message",
        content: "Please check this",
        timestamp: 10,
        communication: {
          executionId: "exec-1",
          fromAgentId: "agent-1",
          fromName: "Helper",
          toAgentId: "agent-2",
          toName: "Other",
          status: "sent",
        },
      },
    ]);

    expect(result.map(({ kind }) => kind)).toEqual([
      "tool-call",
      "mcp-call",
      "tool-result",
      "bot-message",
    ]);
    expect(result[1]?.details).toMatchObject({
      name: "mcp__github__issues",
      arguments: { repo: "x" },
    });
    expect(result[3]?.details).toMatchObject({
      communication: { executionId: "exec-1", toAgentId: "agent-2" },
    });
  });

  test("sorts newest first and preserves stable identities", () => {
    const events = operationalActivity({ id: "a", name: "A" }, [
      {
        id: "a:1:0",
        entryId: "a:1",
        role: "assistant",
        content: "",
        timestamp: 1,
        blocks: [{ type: "toolCall", name: "x" }],
      },
      {
        id: "a:2:0",
        entryId: "a:2",
        role: "assistant",
        content: "",
        timestamp: 2,
        blocks: [{ type: "toolCall", name: "y" }],
      },
    ]);

    const sorted = sortActivity(events);
    expect(sorted.map((event) => event.entryId)).toEqual(["a:2", "a:1"]);
    expect(sorted[1]?.id).toBe("a:a:1:0:block-0");
  });

  test("exposes nested codemode calls, including MCP calls", () => {
    const events = operationalActivity({ id: "a", name: "A" }, [
      {
        id: "a:9:0",
        entryId: "a:9",
        role: "toolResult",
        content: "",
        toolCallId: "codemode-1",
        toolDetails: {
          calls: [
            {
              id: 1,
              name: "echo",
              args: '{"text":"hi"}',
              status: "ok",
              durationMs: 4,
            },
            {
              id: 2,
              name: "mcp_1234abcd_lookup",
              args: "{}",
              status: "error",
              error: "down",
            },
          ],
        },
      },
    ]);

    expect(
      events
        .filter((event) => event.id.includes("nested-"))
        .map((event) => event.kind),
    ).toEqual(["tool-call", "mcp-call"]);
    expect(events[2]?.details).toMatchObject({
      status: "error",
      error: "down",
    });
  });

  test("pages bots and changes newest first without gaps or repeats", async () => {
    // Text messages make some pages empty of activity; timestamps interleave the bots.
    const transcript = (agentId: string, offset: number) =>
      Array.from({ length: 45 }, (_, entry): TranscriptMessage => {
        const base = {
          id: `${agentId}:${entry}:0`,
          entryId: `${agentId}:${entry}`,
          content: "x",
          timestamp: entry * 10 + offset,
        };

        return entry % 7 !== 0
          ? { ...base, role: "assistant" }
          : { ...base, role: "toolResult", toolCallId: `c${entry}` };
      });

    const transcripts = new Map([
      ["a", transcript("a", 0)],
      ["b", transcript("b", 5)],
    ]);

    const changes: LearnedChange[] = Array.from({ length: 7 }, (_, n) => ({
      id: `change-${n}`,
      agentId: n % 2 ? "a" : null,
      actor: "review",
      target: "memory",
      targetId: `m${n}`,
      action: "create",
      before: null,
      after: null,
      source: null,
      revertsId: null,
      createdAt: new Date(n * 33 + 1).toISOString(),
    }));

    const options = {
      agents: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      // Two entries per page, so the five-page budget runs out mid-transcript.
      history: async (agent: { id: string }, before: string | undefined) => {
        const messages = transcripts.get(agent.id)!;
        const end = before ? Number(before.split(":")[1]) : messages.length;
        const page = messages.slice(Math.max(0, end - 2), end);

        return {
          messages: page,
          hasMore: end > 2,
          oldestEntryId: page[0]?.entryId ?? null,
        };
      },
      changes: (limit: number, before: string | undefined) => {
        const newest = changes.toReversed();
        const start = before ? newest.findIndex((c) => c.id === before) + 1 : 0;

        return newest.slice(start, start + limit);
      },
      agentName: (id: string) => id.toUpperCase(),
      limit: 4,
    };

    const all = [
      ...sortActivity([
        ...operationalActivity({ id: "a", name: "A" }, transcripts.get("a")!),
        ...operationalActivity({ id: "b", name: "B" }, transcripts.get("b")!),
      ]).map((item) => ({ id: item.id, kind: item.kind, t: item.timestamp! })),
      ...changes.map((c) => ({
        id: c.id,
        kind: "change" as const,
        t: Date.parse(c.createdAt),
      })),
    ].sort((x, y) => y.t - x.t);

    for (const kind of [undefined, "tool-result", "change"] as const) {
      const seen: string[] = [];
      let cursor: string | null = null;

      for (let request = 0; request < 100; request++) {
        const page: Awaited<ReturnType<typeof activityPage>> =
          await activityPage({
            ...options,
            kind,
            cursor: cursor ? decodeCursor(cursor) : null,
          });

        expect(page.activities.length).toBeLessThanOrEqual(4);
        seen.push(...page.activities.map((item) => item.id));
        cursor = page.nextCursor;

        if (!page.hasMore) break;
      }

      expect(cursor).toBeNull();

      const expected = all
        .filter((item) => !kind || item.kind === kind)
        .map((item) => item.id);

      expect(seen).toEqual(expected);
    }
  });
});
