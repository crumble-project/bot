import { botRequestRequest } from "../shared/request-ids";
import { and, desc, eq } from "drizzle-orm";
import type { JsonValue } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Context, Effect, Layer } from "effect";
import { agentInput, type Agent, type AgentInput } from "../contract/agents";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { AgentRepository } from "../bots/agent-repository";
import { BotExtensions, ExtensionPosition } from "../bots/bot-extensions";
import { BotNotices, loggedNotices } from "../bots/bot-notices";
import { Conflict, NotFound, type AppError } from "../shared/errors";
import { BOT_REQUEST_STATUSES, botRequests } from "./schema";
import { toolOutput } from "../shared/tool-output";
import { defaultAvatarDefinition } from "../contract/avatar";
import { BOT_TOOL, REQUEST_BOT_TOOL_NAME } from "../contract/tools";
import {
  MAX_BOT_DESCRIPTION_CHARS,
  MAX_BOT_MCP_SERVERS,
  MAX_BOT_NAME_CHARS,
  MAX_BOT_TOOLS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_MODEL_ID_CHARS,
  MAX_PROVIDER_ID_CHARS,
  MAX_REQUEST_REASON_CHARS,
  MAX_TOOL_ID_CHARS,
} from "../shared/limits";

export type BotRequest = {
  id: string;
  agentId: string;
  proposal: AgentInput;
  reason: string;
  status: (typeof BOT_REQUEST_STATUSES)[number];
  createdAgentId: string | null;
  requestedAt: string;
  decidedAt: string | null;
};

const requestOf = (row: typeof botRequests.$inferSelect): BotRequest => ({
  id: row.id,
  agentId: row.agentId,
  proposal: agentInput.parse(JSON.parse(row.proposal)),
  reason: row.reason,
  status: row.status,
  createdAgentId: row.createdAgentId,
  requestedAt: row.requestedAt,
  decidedAt: row.decidedAt,
});

export class BotRequests extends Context.Service<
  BotRequests,
  {
    readonly request: (
      agentId: string,
      input: { proposal: AgentInput; reason: string },
    ) => Effect.Effect<BotRequest, AppError>;
    readonly list: (agentId: string) => Effect.Effect<BotRequest[]>;
    /** `decide` runs only on a pending request: what the owner approves, given what the bot proposed. */
    readonly approve: (
      agentId: string,
      requestId: string,
      decide?: (proposal: AgentInput) => Effect.Effect<AgentInput, AppError>,
    ) => Effect.Effect<{ request: BotRequest; agent: Agent }, AppError>;
    readonly decline: (
      agentId: string,
      requestId: string,
    ) => Effect.Effect<BotRequest, AppError>;
  }
>()("crumble/bot-requests/BotRequests") {
  static readonly layer = Layer.effect(
    BotRequests,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const agents = yield* AgentRepository;
      const notices = yield* BotNotices;

      const notify = loggedNotices(notices, "Bot request notice failed");

      const getRow = Effect.fnUntraced(function* (
        agentId: string,
        requestId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(botRequests)
          .where(
            and(
              eq(botRequests.agentId, agentId),
              eq(botRequests.id, requestId),
            ),
          )
          .pipe(Effect.orDie);

        return row;
      });

      const pendingRow = Effect.fnUntraced(function* (
        agentId: string,
        requestId: string,
      ) {
        const row = yield* getRow(agentId, requestId);

        if (!row)
          return yield* Effect.fail(
            new NotFound({ message: "Bot request not found" }),
          );

        if (row.status !== "pending")
          return yield* Effect.fail(
            new Conflict({ message: "Bot request has already been decided" }),
          );

        return row;
      });

      const alreadyDecided = (agentId: string, requestId: string) =>
        pendingRow(agentId, requestId).pipe(
          Effect.flatMap(() =>
            Effect.fail(
              new Conflict({
                message: "Bot request has already been decided",
              }),
            ),
          ),
        );

      const claim = Effect.fnUntraced(function* (
        agentId: string,
        requestId: string,
        status: "approved" | "declined",
        decidedAt: string,
      ) {
        const changed = yield* db
          .update(botRequests)
          .set({ status, decidedAt })
          .where(
            and(
              eq(botRequests.id, requestId),
              eq(botRequests.agentId, agentId),
              eq(botRequests.status, "pending"),
            ),
          )
          .returning({ id: botRequests.id })
          .pipe(Effect.orDie);

        return changed.length > 0;
      });

      const request = Effect.fn("BotRequests.request")(function* (
        agentId: string,
        input: { proposal: AgentInput; reason: string },
      ) {
        const at = yield* nowIso;
        const id = crypto.randomUUID();
        yield* db
          .transaction(() =>
            Effect.gen(function* () {
              const [pending] = yield* db
                .select({ id: botRequests.id })
                .from(botRequests)
                .where(
                  and(
                    eq(botRequests.agentId, agentId),
                    eq(botRequests.status, "pending"),
                  ),
                )
                .limit(1)
                .pipe(Effect.orDie);

              if (pending)
                return yield* Effect.fail(
                  new Conflict({
                    message: "A bot request is already pending; please wait.",
                  }),
                );
              yield* db
                .insert(botRequests)
                .values({
                  id,
                  agentId,
                  proposal: JSON.stringify({
                    ...input.proposal,
                    avatar:
                      input.proposal.avatar ?? defaultAvatarDefinition(id),
                  }),
                  reason: input.reason,
                  status: "pending",
                  createdAgentId: null,
                  requestedAt: at,
                  decidedAt: null,
                })
                .pipe(Effect.orDie);
            }),
          )
          .pipe(
            Effect.catch((error) =>
              error instanceof Conflict
                ? Effect.fail(error)
                : Effect.die(error),
            ),
          );
        const row = yield* getRow(agentId, id);

        return row
          ? requestOf(row)
          : yield* Effect.die(new Error("Inserted bot request disappeared"));
      });

      const list = Effect.fn("BotRequests.list")(function* (agentId: string) {
        const rows = yield* db
          .select()
          .from(botRequests)
          .where(eq(botRequests.agentId, agentId))
          .orderBy(desc(botRequests.requestedAt))
          .pipe(Effect.orDie);

        return rows.map(requestOf);
      });

      const approve = Effect.fn("BotRequests.approve")(function* (
        agentId: string,
        requestId: string,
        decide: (
          proposal: AgentInput,
        ) => Effect.Effect<AgentInput, AppError> = Effect.succeed,
      ) {
        const row = yield* pendingRow(agentId, requestId);
        const nextProposal = yield* decide(requestOf(row).proposal);
        const at = yield* nowIso;

        const { agent, updated } = yield* db
          .transaction(() =>
            Effect.gen(function* () {
              if (!(yield* claim(agentId, requestId, "approved", at)))
                return yield* alreadyDecided(agentId, requestId);

              const agent = yield* agents.create(nextProposal);
              yield* db
                .update(botRequests)
                .set({
                  createdAgentId: agent.id,
                  proposal: JSON.stringify(nextProposal),
                })
                .where(eq(botRequests.id, requestId))
                .pipe(Effect.orDie);
              const updated = yield* getRow(agentId, requestId);

              if (!updated)
                return yield* Effect.die(
                  new Error("Approved bot request disappeared"),
                );

              return { agent, updated };
            }),
          )
          .pipe(Effect.catchTag("SqlError", (error) => Effect.die(error)));

        yield* notify(
          agentId,
          `The owner approved your request for bot ${agent.name}.`,
          botRequestRequest(requestId),
        );

        return { request: requestOf(updated), agent };
      });

      const decline = Effect.fn("BotRequests.decline")(function* (
        agentId: string,
        requestId: string,
      ) {
        const row = yield* pendingRow(agentId, requestId);
        const at = yield* nowIso;

        if (!(yield* claim(agentId, requestId, "declined", at)))
          return yield* alreadyDecided(agentId, requestId);

        const updated = yield* getRow(agentId, requestId);

        if (!updated)
          return yield* Effect.die(
            new Error("Declined bot request disappeared"),
          );
        yield* notify(
          agentId,
          `The owner declined your request for bot ${requestOf(row).proposal.name}.`,
          botRequestRequest(requestId),
        );

        return requestOf(updated);
      });

      return BotRequests.of({ request, list, approve, decline });
    }),
  );
}

export function botRequestExtension(
  agent: Agent,
  service: BotRequests["Service"],
) {
  const request = defineTool({
    name: REQUEST_BOT_TOOL_NAME,
    description:
      "Ask the owner to create a new bot. The owner approves, edits, or declines your proposal in this chat. The new bot is independent of you, and credentials are never shared: it must request its own credentials. Only one request can be pending at a time. After calling, tell the owner what you proposed and why, then end your turn: a message arrives when the owner answers.",
    parameters: Type.Object({
      name: Type.String({ minLength: 1, maxLength: MAX_BOT_NAME_CHARS }),
      description: Type.String({ maxLength: MAX_BOT_DESCRIPTION_CHARS }),
      instructions: Type.String({ maxLength: MAX_INSTRUCTIONS_CHARS }),
      tools: Type.Array(
        Type.String({ minLength: 1, maxLength: MAX_TOOL_ID_CHARS }),
        {
          maxItems: MAX_BOT_TOOLS,
        },
      ),
      mcpServers: Type.Array(Type.String({ minLength: 1, maxLength: 36 }), {
        maxItems: MAX_BOT_MCP_SERVERS,
      }),
      reason: Type.String({
        minLength: 1,
        maxLength: MAX_REQUEST_REASON_CHARS,
      }),
      provider: Type.Optional(
        Type.String({ minLength: 1, maxLength: MAX_PROVIDER_ID_CHARS }),
      ),
      model: Type.Optional(
        Type.String({ minLength: 1, maxLength: MAX_MODEL_ID_CHARS }),
      ),
    }),
    callers: ["model"],
    replay: "unsafe",
    execute: async (args) => {
      const proposal = agentInput.parse({
        name: args.name,
        description: args.description,
        instructions: args.instructions,
        provider: args.provider ?? agent.provider,
        model: args.model ?? agent.model,
        enabled: true,
        tools: args.tools,
        mcpServers: args.mcpServers,
        skills: [],
        sharedSkills: [],
        inference: agent.inference,
      });

      const saved = Effect.runSync(
        service.request(agent.id, { proposal, reason: args.reason }),
      );

      // SAFETY: BotRequest contains only JSON data; serialization removes optional undefined fields.
      const details = JSON.parse(JSON.stringify(saved)) as JsonValue;

      return { ...toolOutput({ request: details }), details };
    },
  });

  return defineExtension({
    name: "bot_requests",
    tools: [request],
    sections: [
      {
        key: "bot_requests",
        render: () => {
          const pending = Effect.runSync(service.list(agent.id)).filter(
            (item) => item.status === "pending",
          );

          return pending.length
            ? [
                "Bot requests awaiting the owner's answer:",
                ...pending.map(
                  (item) => `- ${item.proposal.name}: ${item.reason}`,
                ),
              ].join("\n")
            : undefined;
        },
      },
    ],
  });
}

export const botRequestTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* BotRequests;
    yield* (yield* BotExtensions).register(
      ExtensionPosition.botRequests,
      (agent) =>
        agent.tools.includes(BOT_TOOL.createBots)
          ? [botRequestExtension(agent, service)]
          : [],
    );
  }),
);
