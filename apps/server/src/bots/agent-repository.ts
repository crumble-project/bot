import { asc, eq, ne } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { OWNER } from "../shared/change-by";
import { STANDARD_TOOLS, type Agent, type AgentInput } from "../shared/domain";
import { ProductDatabase } from "../shared/product-database";
import { nowIso } from "../shared/time";
import { McpServerRepository } from "../integrations/mcp-server-repository";
import { SkillRepository } from "../skills/skill-repository";
import { agents } from "./schema";

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
    /** A copy with the same settings and skill packages; archived skills and the original's own servers stay behind. */
    readonly duplicate: (
      agentId: string,
      name?: string,
    ) => Effect.Effect<Agent | null>;
  }
>()("crumble/bots/AgentRepository") {
  static readonly layer = Layer.effect(
    AgentRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;
      const skillLibrary = yield* SkillRepository;
      const servers = yield* McpServerRepository;

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
          avatar: row.avatar,
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
          sharedMemory: tools.includes("memory"),
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
        avatar: input.avatar,
        description: input.description,
        instructions: input.instructions,
        provider: input.provider,
        model: input.model,
        webSearchProvider: input.webSearchProvider ?? null,
        enabled: input.enabled,
        tools: JSON.stringify(input.tools),
        skills: "[]",
        sharedSkills: JSON.stringify(input.sharedSkills ?? []),
        sharedMemory: input.sharedMemory ?? false,
        mcpServers: JSON.stringify(input.mcpServers),
        delegates: JSON.stringify(input.delegates ?? []),
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
          .set({ ...columns({ ...old, ...patch }), updatedAt: yield* nowIso })
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

      const duplicate = Effect.fn("AgentRepository.duplicate")(function* (
        agentId: string,
        name?: string,
      ) {
        const original = yield* get(agentId);

        if (!original) return null;

        // Personal servers keep belonging to the original bot.
        const mcpServers: string[] = [];

        for (const serverId of original.mcpServers)
          if (!(yield* servers.get(serverId))?.agentId)
            mcpServers.push(serverId);

        const copy = yield* create({
          ...original,
          mcpServers,
          skills: [],
          name: name ?? `${original.name} Copy`,
        });

        // Skill packages are copied whole; archived ones stay behind, and the copy's skills were not learned from an execution.
        for (const skill of yield* skillLibrary.list(original.id))
          if (skill.state !== "archived")
            yield* skillLibrary.create(
              {
                ...skill,
                agentId: copy.id,
                sourceExecutionId: null,
                state: skill.state,
                pinned: skill.pinned,
              },
              undefined,
              OWNER,
            );

        return yield* get(copy.id);
      });

      return AgentRepository.of({
        list,
        get,
        create,
        update,
        delete: remove,
        duplicate,
      });
    }),
  );
}
