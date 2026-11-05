import { asc, eq, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import type { Agent, AgentInput } from "../contract/agents";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { SkillRepository } from "../skills/skill-repository";
import { agents } from "./schema";
import {
  avatarDefinitionSchema,
  defaultAvatarDefinition,
} from "../contract/avatar";
import { BOT_TOOL, STANDARD_TOOLS } from "../contract/tools";

export type AgentPatch = Partial<
  Omit<AgentInput, "id" | "createdAt" | "updatedAt">
>;

/** The account's bots and their settings; their skills live in the skill library. */
export class AgentRepository extends Context.Service<
  AgentRepository,
  {
    /** Oldest first. */
    readonly list: Effect.Effect<Agent[]>;
    readonly get: (agentId: string) => Effect.Effect<Agent | null>;
    readonly create: (
      input: AgentInput,
      agentId?: string,
    ) => Effect.Effect<Agent>;
    readonly update: (
      agentId: string,
      patch: AgentPatch,
    ) => Effect.Effect<Agent | null>;
    readonly delete: (agentId: string) => Effect.Effect<boolean>;
  }
>()("crumble/bots/AgentRepository") {
  static readonly layer = Layer.effect(
    AgentRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const skillLibrary = yield* SkillRepository;

      const agentOf = Effect.fnUntraced(function* (
        row: typeof agents.$inferSelect,
      ) {
        const tools: string[] = [
          ...new Set([...STANDARD_TOOLS, ...JSON.parse(row.tools)]),
        ];

        const others = yield* db
          .select({ id: agents.id })
          .from(agents)
          .where(ne(agents.id, row.id))
          .orderBy(asc(agents.createdAt));

        const skills = yield* skillLibrary.list(row.id);

        const agent: Agent = {
          id: row.id,
          name: row.name,
          avatar: avatarDefinitionSchema.parse(JSON.parse(row.avatar)),
          description: row.description,
          instructions: row.instructions,
          provider: row.provider,
          model: row.model,
          webSearchProvider: row.webSearchProvider,
          enabled: row.enabled,
          tools,
          skills: skills.map(({ name, instructions }) => ({
            name,
            instructions,
          })),
          sharedSkills: JSON.parse(row.sharedSkills),
          sharedMemory: tools.includes(BOT_TOOL.memory),
          mcpServers: JSON.parse(row.mcpServers),
          delegates: others.map((other) => other.id),
          inference: JSON.parse(row.inference),
          ...(row.desktopModel && {
            desktopModel: JSON.parse(row.desktopModel),
          }),
          ...(row.reviewModel && { reviewModel: JSON.parse(row.reviewModel) }),
          ...(row.review && { review: JSON.parse(row.review) }),
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        };

        return agent;
      });

      const list = Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(agents)
          .orderBy(asc(agents.createdAt));

        return yield* Effect.forEach(rows, agentOf);
      }).pipe(Effect.orDie, Effect.withSpan("AgentRepository.list"));

      const get = Effect.fn("AgentRepository.get")(function* (agentId: string) {
        const [row] = yield* db
          .select()
          .from(agents)
          .where(eq(agents.id, agentId));

        return row ? yield* agentOf(row) : null;
      }, Effect.orDie);

      const columns = (input: AgentPatch & AgentInput) => ({
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        provider: input.provider,
        model: input.model,
        webSearchProvider: input.webSearchProvider ?? null,
        enabled: input.enabled,
        tools: JSON.stringify(input.tools),
        sharedSkills: JSON.stringify(input.sharedSkills ?? []),
        mcpServers: JSON.stringify(input.mcpServers),
        inference: JSON.stringify(input.inference ?? {}),
        desktopModel: input.desktopModel
          ? JSON.stringify(input.desktopModel)
          : null,
        reviewModel: input.reviewModel
          ? JSON.stringify(input.reviewModel)
          : null,
        review: input.review ? JSON.stringify(input.review) : null,
      });

      const create = Effect.fn("AgentRepository.create")(function* (
        input: AgentInput,
        agentId: string = crypto.randomUUID(),
      ) {
        const at = yield* nowIso;

        yield* db.insert(agents).values({
          id: agentId,
          ...columns(input),
          avatar: JSON.stringify(
            avatarDefinitionSchema.parse(
              input.avatar ?? defaultAvatarDefinition(agentId),
            ),
          ),
          createdAt: at,
          updatedAt: at,
        });
        yield* skillLibrary.replaceAgentSkills(agentId, input.skills);

        return (yield* get(agentId))!;
      }, Effect.orDie);

      const update = Effect.fn("AgentRepository.update")(function* (
        agentId: string,
        patch: AgentPatch,
      ) {
        const old = yield* get(agentId);

        if (!old) return null;

        yield* db
          .update(agents)
          .set({
            ...columns({ ...old, ...patch }),
            avatar: JSON.stringify(
              avatarDefinitionSchema.parse(patch.avatar ?? old.avatar),
            ),
            updatedAt: yield* nowIso,
          })
          .where(eq(agents.id, agentId));

        if (patch.skills)
          yield* skillLibrary.replaceAgentSkills(agentId, patch.skills);

        return yield* get(agentId);
      }, Effect.orDie);

      const remove = Effect.fn("AgentRepository.delete")(function* (
        agentId: string,
      ) {
        const deleted = yield* db
          .delete(agents)
          .where(eq(agents.id, agentId))
          .returning({ id: agents.id });

        return deleted.length > 0;
      }, Effect.orDie);

      return AgentRepository.of({
        list,
        get,
        create,
        update,
        delete: remove,
      });
    }),
  );
}
