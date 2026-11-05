import { asc, eq } from "drizzle-orm";
import { Context, Effect, Layer } from "effect";
import { ProductDatabase } from "../shared/product-database";
import { mcpServers } from "./schema";

export type MCPServer = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  agentId: string | null;
  /** A client the owner registered with the server's authorization server, for servers that register none themselves. */
  oauthClientId: string | null;
};

export type NewMCPServer = Omit<
  MCPServer,
  "id" | "agentId" | "oauthClientId"
> & {
  agentId?: string | null | undefined;
  oauthClientId?: string | null | undefined;
};

const serverOf = (row: typeof mcpServers.$inferSelect): MCPServer => ({
  id: row.id,
  name: row.name,
  url: row.url,
  enabled: row.enabled,
  agentId: row.agentId ?? null,
  oauthClientId: row.oauthClientId ?? null,
});

export class McpServerRepository extends Context.Service<
  McpServerRepository,
  {
    readonly list: Effect.Effect<MCPServer[]>;
    readonly get: (serverId: string) => Effect.Effect<MCPServer | null>;
    readonly usable: (
      agentId: string,
      serverId: string,
    ) => Effect.Effect<MCPServer | null>;
    readonly create: (
      input: NewMCPServer,
      serverId?: string,
    ) => Effect.Effect<MCPServer>;
    readonly update: (
      serverId: string,
      patch: Partial<Omit<MCPServer, "id" | "agentId">>,
    ) => Effect.Effect<MCPServer | null>;
    readonly delete: (serverId: string) => Effect.Effect<boolean>;
  }
>()("crumble/integrations/McpServerRepository") {
  static readonly layer = Layer.effect(
    McpServerRepository,
    Effect.gen(function* () {
      const db = yield* ProductDatabase;

      const list = db
        .select()
        .from(mcpServers)
        .orderBy(asc(mcpServers.name))
        .pipe(
          Effect.map((rows) => rows.map(serverOf)),
          Effect.orDie,
          Effect.withSpan("McpServerRepository.list"),
        );

      const get = Effect.fn("McpServerRepository.get")(function* (
        serverId: string,
      ) {
        const [row] = yield* db
          .select()
          .from(mcpServers)
          .where(eq(mcpServers.id, serverId));

        return row ? serverOf(row) : null;
      }, Effect.orDie);

      const usable = Effect.fn("McpServerRepository.usable")(function* (
        agentId: string,
        serverId: string,
      ) {
        const server = yield* get(serverId);

        return server?.enabled &&
          (!server.agentId || server.agentId === agentId)
          ? server
          : null;
      });

      const create = Effect.fn("McpServerRepository.create")(function* (
        input: NewMCPServer,
        serverId: string = crypto.randomUUID(),
      ) {
        yield* db.insert(mcpServers).values({
          id: serverId,
          name: input.name,
          url: input.url,
          enabled: input.enabled,
          agentId: input.agentId ?? null,
          oauthClientId: input.oauthClientId ?? null,
        });

        return (yield* get(serverId))!;
      }, Effect.orDie);

      const update = Effect.fn("McpServerRepository.update")(function* (
        serverId: string,
        patch: Partial<Omit<MCPServer, "id" | "agentId">>,
      ) {
        const server = yield* get(serverId);

        if (!server) return null;
        const next = { ...server, ...patch };

        yield* db
          .update(mcpServers)
          .set({
            name: next.name,
            url: next.url,
            enabled: next.enabled,
            oauthClientId: next.oauthClientId,
          })
          .where(eq(mcpServers.id, serverId));

        return yield* get(serverId);
      }, Effect.orDie);

      const remove = Effect.fn("McpServerRepository.delete")(function* (
        serverId: string,
      ) {
        const deleted = yield* db
          .delete(mcpServers)
          .where(eq(mcpServers.id, serverId))
          .returning({ id: mcpServers.id });

        return deleted.length > 0;
      }, Effect.orDie);

      return McpServerRepository.of({
        list,
        get,
        usable,
        create,
        update,
        delete: remove,
      });
    }),
  );
}
