import { Context, Effect, Layer } from "effect";
import type { z } from "zod";
import type { Agent } from "../contract/agents";
import type {
  describedMcpServerResponse,
  mcpServerResponse,
} from "../contract/api-responses";
import type { mcpCreateInput, mcpInput } from "../contract/api-contract";
import type { SecretInput } from "../contract/secrets";
import { AgentRepository } from "../bots/agent-repository";
import { BotDeletion } from "../bots/bot-deletion";
import { Secrets } from "../secrets/secrets";
import type { ServerSecrets } from "../secrets/server-secrets";
import { pi } from "../shared/app-errors";
import { InvalidInput, NotFound, type AppError } from "../shared/errors";
import { MAX_BOT_MCP_SERVERS } from "../shared/limits";
import { runnerOf } from "../shared/runner";
import { McpIntegrations } from "./integrations";
import {
  clientSecretKey,
  finishAuthorization,
  hasOAuthTokens,
  mcpTokenKey,
  secretStorage,
  signOut,
  startAuthorization,
} from "./mcp-oauth";
import { McpServerRepository, type MCPServer } from "./mcp-server-repository";

/** The server with its secrets' status, never their values. */
type McpServerSecrets = z.infer<typeof mcpServerResponse>;

/** The server as the owner's client sees it: its auth state plus the last connection failure. */
type McpServerStatus = z.infer<typeof describedMcpServerResponse>;

/** The account's MCP servers: their records, secrets, sign-ins, and open connections change together here. */
export class McpServers extends Context.Service<
  McpServers,
  {
    readonly list: Effect.Effect<McpServerStatus[]>;
    readonly get: (id: string) => Effect.Effect<MCPServer, NotFound>;
    /** Adds a server and lets the bot that owns it use it right away. */
    readonly create: (
      input: z.output<typeof mcpCreateInput>,
      owner: Agent | null,
    ) => Effect.Effect<McpServerSecrets, AppError>;
    /**
     * Saves the secrets an edit sends. A new token, or another OAuth app, closes the open connection; another OAuth app
     * also signs the server out, since tokens belong to the client that obtained them.
     */
    readonly update: (
      old: MCPServer,
      input: z.output<typeof mcpInput>,
    ) => Effect.Effect<McpServerSecrets | null, AppError>;
    readonly delete: (id: string) => Effect.Effect<void, NotFound>;
    readonly startSignIn: (
      id: string,
      redirectUri: string,
    ) => Effect.Effect<
      { authorizationUrl: string } | { authorized: true },
      AppError
    >;
    readonly finishSignIn: (
      id: string,
      answer: { code: string; state: string; iss?: string | undefined },
    ) => Effect.Effect<McpServerStatus, AppError>;
    readonly signOut: (id: string) => Effect.Effect<McpServerStatus, NotFound>;
    /** A bot may use shared servers and its own, never another bot's. */
    readonly check: (
      agentId: string | null,
      serverIds: readonly string[],
      requireExisting?: boolean,
    ) => Effect.Effect<void, InvalidInput>;
  }
>()("crumble/integrations/McpServers") {
  static readonly layer = Layer.effect(
    McpServers,
    Effect.gen(function* () {
      const servers = yield* McpServerRepository;
      const agents = yield* AgentRepository;
      const secrets = yield* Secrets;
      const integrations = yield* McpIntegrations;
      const deletion = yield* BotDeletion;
      const { oauthClient } = integrations;

      const storage = secretStorage(
        runnerOf(yield* Effect.context<ServerSecrets | Secrets>()),
      );

      const withSecrets = Effect.fnUntraced(function* (server: MCPServer) {
        return {
          ...server,
          token: yield* secrets.status(mcpTokenKey(server.id)),
          oauthClientSecret: yield* secrets.status(clientSecretKey(server.id)),
        };
      });

      const describe = Effect.fnUntraced(function* (server: MCPServer) {
        const described = yield* withSecrets(server);

        const auth = hasOAuthTokens(storage, server.id)
          ? "oauth"
          : described.token.configured
            ? "token"
            : "none";

        return {
          ...described,
          auth,
          authenticated: auth !== "none",
          error: integrations.failure(server.id),
        } as const;
      });

      const get = Effect.fn("McpServers.get")(function* (id: string) {
        const server = yield* servers.get(id);

        if (!server)
          return yield* new NotFound({ message: "MCP server not found" });

        return server;
      });

      /** Saves, or with null removes, one of the server's secrets; returns whether one was sent. */
      const storeSecret = Effect.fnUntraced(function* (
        key: string,
        input: SecretInput | null | undefined,
      ) {
        if (input === undefined) return false;

        if (input === null) yield* secrets.delete(key);
        else yield* secrets.save(key, input);

        return true;
      });

      /** Forgets a deleted server's secrets and sign-in and closes its connection. */
      const forget = Effect.fnUntraced(function* (id: string) {
        yield* secrets.delete(mcpTokenKey(id));
        yield* secrets.delete(clientSecretKey(id));
        signOut(storage, id);
        yield* integrations.disconnect(id);
      });

      // A bot's personal servers go with it in the delete's cascade, so they are listed first.
      yield* deletion.register((agentId) =>
        Effect.map(servers.list, (all) =>
          Effect.forEach(
            all.filter((server) => server.agentId === agentId),
            (server) => forget(server.id),
            { discard: true },
          ),
        ),
      );

      const create = Effect.fn("McpServers.create")(function* (
        input: z.output<typeof mcpCreateInput>,
        owner: Agent | null,
      ) {
        if (owner && owner.mcpServers.length >= MAX_BOT_MCP_SERVERS)
          return yield* new InvalidInput({
            message: `${owner.name} already uses ${MAX_BOT_MCP_SERVERS} MCP servers`,
          });

        const server = yield* servers.create(input);

        // A secret that can't be saved, such as an unreadable reference, takes the server with it.
        yield* storeSecret(mcpTokenKey(server.id), input.token).pipe(
          Effect.andThen(
            storeSecret(clientSecretKey(server.id), input.oauthClientSecret),
          ),
          Effect.onError(() =>
            servers
              .delete(server.id)
              .pipe(Effect.andThen(secrets.delete(mcpTokenKey(server.id)))),
          ),
        );

        if (owner)
          yield* agents.update(owner.id, {
            mcpServers: [...owner.mcpServers, server.id],
          });

        return yield* withSecrets(server);
      });

      const update = Effect.fn("McpServers.update")(function* (
        old: MCPServer,
        input: z.output<typeof mcpInput>,
      ) {
        const tokenChanged = yield* storeSecret(
          mcpTokenKey(old.id),
          input.token,
        );

        const appChanged =
          (yield* storeSecret(
            clientSecretKey(old.id),
            input.oauthClientSecret,
          )) || (input.oauthClientId ?? null) !== old.oauthClientId;

        if (appChanged) signOut(storage, old.id);

        if (tokenChanged || appChanged) yield* integrations.disconnect(old.id);

        const updated = yield* servers.update(old.id, {
          ...input,
          oauthClientId: input.oauthClientId ?? null,
        });

        return updated && (yield* withSecrets(updated));
      });

      const remove = Effect.fn("McpServers.delete")(function* (id: string) {
        if (!(yield* servers.delete(id)))
          return yield* new NotFound({ message: "MCP server not found" });

        yield* forget(id);
      });

      const startSignIn = Effect.fn("McpServers.startSignIn")(function* (
        id: string,
        redirectUri: string,
      ) {
        const server = yield* get(id);

        return yield* pi(() =>
          startAuthorization(storage, server, redirectUri, oauthClient),
        );
      });

      const finishSignIn = Effect.fn("McpServers.finishSignIn")(function* (
        id: string,
        answer: { code: string; state: string; iss?: string | undefined },
      ) {
        const server = yield* get(id);

        yield* pi(() =>
          finishAuthorization(
            storage,
            server,
            answer.code,
            answer.state,
            answer.iss,
            oauthClient,
          ),
        );
        yield* integrations.disconnect(server.id);

        return yield* describe(server);
      });

      const signOutServer = Effect.fn("McpServers.signOut")(function* (
        id: string,
      ) {
        const server = yield* get(id);

        signOut(storage, server.id);
        yield* integrations.disconnect(server.id);

        return yield* describe(server);
      });

      const check = Effect.fn("McpServers.check")(function* (
        agentId: string | null,
        serverIds: readonly string[],
        requireExisting = false,
      ) {
        for (const serverId of serverIds) {
          const server = yield* servers.get(serverId);

          if (!server && requireExisting)
            return yield* new InvalidInput({
              message: "That MCP server does not exist",
            });

          if (server?.agentId && server.agentId !== agentId)
            return yield* new InvalidInput({
              message: "That MCP server belongs to another bot",
            });
        }
      });

      return McpServers.of({
        list: Effect.flatMap(servers.list, Effect.forEach(describe)),
        get,
        create,
        update,
        delete: remove,
        startSignIn,
        finishSignIn,
        signOut: signOutServer,
        check,
      });
    }),
  );
}
