import { Effect } from "effect";
import type { z } from "zod";
import type { mcpCreateInput, mcpInput } from "../contract/api-contract";
import { AgentRepository } from "../bots/agent-repository";
import { Secrets } from "../secrets/secrets";
import type { ServerSecrets } from "../secrets/server-secrets";
import type { Agent, MCPServer, SecretInput } from "../shared/domain";
import { InvalidInput, NotFound } from "../shared/errors";
import { MAX_BOT_MCP_SERVERS } from "../shared/limits";
import type { Runner } from "../shared/runner";
import type { McpIntegrations } from "./integrations";
import {
  clientSecretKey,
  finishAuthorization,
  hasOAuthTokens,
  mcpTokenKey,
  secretStorage,
  signOut,
  startAuthorization,
  type ClientDocument,
  type SecretStorage,
} from "./mcp-oauth";
import { McpServerRepository } from "./mcp-server-repository";

type Services = AgentRepository | McpServerRepository | Secrets | ServerSecrets;

type McpServersOptions = {
  run: Runner<Services>;
  /** Absent when the API runs without the account's connections, such as in fixtures. */
  integrations?: McpIntegrations["Service"] | undefined;
  /** The server's OAuth client metadata document, when it has a public address. */
  oauthClient?: ClientDocument | undefined;
};

/** The account's MCP servers: their records, secrets, sign-ins, and open connections change together here. */
export class McpServers {
  private readonly storage: SecretStorage;

  constructor(private readonly options: McpServersOptions) {
    this.storage = secretStorage(options.run);
  }

  private exec<A>(effect: Effect.Effect<A, never, Services>) {
    return this.options.run.runSync(effect);
  }

  /** The server with its secrets' status, never their values. */
  private withSecrets(server: MCPServer) {
    return {
      ...server,
      token: this.exec(Secrets.use((s) => s.status(mcpTokenKey(server.id)))),
      oauthClientSecret: this.exec(
        Secrets.use((s) => s.status(clientSecretKey(server.id))),
      ),
    };
  }

  /** The server as the owner's client sees it: its auth state plus the last connection failure. */
  private describe(server: MCPServer) {
    const described = this.withSecrets(server);

    const auth = hasOAuthTokens(this.storage, server.id)
      ? "oauth"
      : described.token.configured
        ? "token"
        : "none";

    return {
      ...described,
      auth,
      authenticated: auth !== "none",
      error: this.options.integrations?.failure(server.id) ?? null,
    } as const;
  }

  get(id: string) {
    const server = this.exec(McpServerRepository.use((r) => r.get(id)));

    if (!server) throw new NotFound({ message: "MCP server not found" });

    return server;
  }

  /** Closes the open connection, so the next use picks up the server's new auth. */
  private disconnect(id: string) {
    const { integrations } = this.options;

    return integrations
      ? Effect.runPromise(integrations.disconnect(id))
      : Promise.resolve();
  }

  /** Saves, or with null removes, one of the server's secrets; returns whether one was sent. */
  private async storeSecret(
    key: string,
    input: SecretInput | null | undefined,
  ) {
    if (input === undefined) return false;

    await this.options.run.runPromise(
      Secrets.use((s) =>
        input === null ? Effect.asVoid(s.delete(key)) : s.save(key, input),
      ),
    );

    return true;
  }

  /** Forgets a deleted server's secrets and sign-in and closes its connection. */
  private async forget(id: string) {
    this.exec(Secrets.use((s) => s.delete(mcpTokenKey(id))));
    this.exec(Secrets.use((s) => s.delete(clientSecretKey(id))));
    signOut(this.storage, id);
    await this.disconnect(id);
  }

  list() {
    return this.exec(McpServerRepository.use((r) => r.list)).map((server) =>
      this.describe(server),
    );
  }

  /** Adds a server and lets the bot that owns it use it right away. */
  async create(input: z.output<typeof mcpCreateInput>, owner: Agent | null) {
    if (owner && owner.mcpServers.length >= MAX_BOT_MCP_SERVERS)
      throw new InvalidInput({
        message: `${owner.name} already uses ${MAX_BOT_MCP_SERVERS} MCP servers`,
      });

    const server = this.exec(McpServerRepository.use((r) => r.create(input)));

    try {
      await this.storeSecret(mcpTokenKey(server.id), input.token);
      await this.storeSecret(
        clientSecretKey(server.id),
        input.oauthClientSecret,
      );
    } catch (error) {
      // A secret that can't be saved, such as an unreadable reference, takes the server with it.
      this.exec(McpServerRepository.use((r) => r.delete(server.id)));
      this.exec(Secrets.use((s) => s.delete(mcpTokenKey(server.id))));
      throw error;
    }

    if (owner)
      this.exec(
        AgentRepository.use((r) =>
          r.update(owner.id, {
            mcpServers: [...owner.mcpServers, server.id],
          }),
        ),
      );

    return this.withSecrets(server);
  }

  /**
   * Saves the secrets an edit sends. A new token, or another OAuth app, closes the open connection; another OAuth app
   * also signs the server out, since tokens belong to the client that obtained them.
   */
  async update(old: MCPServer, input: z.output<typeof mcpInput>) {
    const tokenChanged = await this.storeSecret(
      mcpTokenKey(old.id),
      input.token,
    );

    const appChanged =
      (await this.storeSecret(
        clientSecretKey(old.id),
        input.oauthClientSecret,
      )) || (input.oauthClientId ?? null) !== old.oauthClientId;

    if (appChanged) signOut(this.storage, old.id);

    if (tokenChanged || appChanged) await this.disconnect(old.id);

    const updated = this.exec(
      McpServerRepository.use((r) =>
        r.update(old.id, {
          ...input,
          oauthClientId: input.oauthClientId ?? null,
        }),
      ),
    );

    return updated && this.withSecrets(updated);
  }

  async delete(id: string) {
    if (!this.exec(McpServerRepository.use((r) => r.delete(id))))
      throw new NotFound({ message: "MCP server not found" });

    await this.forget(id);
  }

  startSignIn(id: string, redirectUri: string) {
    return startAuthorization(
      this.storage,
      this.get(id),
      redirectUri,
      this.options.oauthClient,
    );
  }

  async finishSignIn(
    id: string,
    answer: { code: string; state: string; iss?: string | undefined },
  ) {
    const server = this.get(id);

    await finishAuthorization(
      this.storage,
      server,
      answer.code,
      answer.state,
      answer.iss,
      this.options.oauthClient,
    );
    await this.disconnect(server.id);

    return this.describe(server);
  }

  async signOut(id: string) {
    const server = this.get(id);

    signOut(this.storage, server.id);
    await this.disconnect(server.id);

    return this.describe(server);
  }

  /** A bot may use shared servers and its own, never another bot's. */
  check(
    agentId: string | null,
    serverIds: readonly string[],
    requireExisting = false,
  ) {
    for (const serverId of serverIds) {
      const server = this.exec(McpServerRepository.use((r) => r.get(serverId)));

      if (!server && requireExisting)
        throw new InvalidInput({ message: "That MCP server does not exist" });

      if (server?.agentId && server.agentId !== agentId)
        throw new InvalidInput({
          message: "That MCP server belongs to another bot",
        });
    }
  }

  /** Runs `deleteBot`, whose cascade takes the bot's personal servers, then forgets them. Lists them first for that. */
  async forgetBot(agentId: string, deleteBot: () => Promise<void>) {
    const personal = this.exec(McpServerRepository.use((r) => r.list)).filter(
      (server) => server.agentId === agentId,
    );

    await deleteBot();

    for (const server of personal) await this.forget(server.id);
  }
}
