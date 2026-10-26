import type { z } from "zod";
import { Effect } from "effect";
import {
  routes,
  mcpCreateInput,
  mcpInput,
  oauthCallbackInput,
  oauthInput,
} from "../contract/api-contract";
import type { Register } from "../contract/route";
import { AgentRepository } from "../bots/agent-repository";
import type { BotsAccess } from "../bots/bots";
import { SecretRepository } from "../credentials/secret-repository";
import type { CoreServices } from "../shared/core-layer";
import type { MCPServer } from "../shared/domain";
import { InvalidInput, NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import type { McpIntegrations } from "./integrations";
import type { ClientDocument } from "./mcp-oauth";
import {
  clientSecretKey,
  finishAuthorization,
  hasOAuthTokens,
  signOut,
  startAuthorization,
  type SecretStorage,
} from "./mcp-oauth";
import { McpServerRepository } from "./mcp-server-repository";

type Exec = Runner<CoreServices>["runSync"];

type McpServerRoutesOptions = {
  register: Register;
  service: BotsAccess;
  /** Runs the repository effects the MCP server routes read and write. */
  run: Runner<CoreServices>;
  secrets: SecretStorage;
  integrations?: McpIntegrations["Service"] | undefined;
  /** The server's OAuth client metadata document, when it has a public address. */
  oauthClient?: ClientDocument | undefined;
};

/** The server as the owner's client sees it: its auth state plus the last connection failure. */
const describeServer = (
  exec: Exec,
  secrets: SecretStorage,
  integrations: McpIntegrations["Service"] | undefined,
  server: MCPServer,
) => {
  const auth = hasOAuthTokens(secrets, server.id)
    ? "oauth"
    : exec(SecretRepository.use((r) => r.get(`mcp:${server.id}`)))
      ? "token"
      : "none";

  return {
    ...server,
    auth,
    authenticated: auth !== "none",
    error: integrations?.failure(server.id) ?? null,
    hasOAuthClientSecret: Boolean(
      exec(SecretRepository.use((r) => r.get(clientSecretKey(server.id)))),
    ),
  } as const;
};

const mcpServer = (exec: Exec, id: string) => {
  const server = exec(McpServerRepository.use((r) => r.get(id)));

  if (!server) throw new NotFound({ message: "MCP server not found" });

  return server;
};

/** Writing an empty secret removes the stored one. */
const storeSecret = (exec: Exec, key: string, value: string | undefined) => {
  if (value === undefined) return;

  if (value) exec(SecretRepository.use((r) => r.set(key, value)));
  else exec(SecretRepository.use((r) => r.delete(key)));
};

/** Adding a server, storing its secrets, and letting the bot that owns it use it right away. */
const addMcpServer = (
  exec: Exec,
  service: BotsAccess,
  input: z.output<typeof mcpCreateInput>,
) => {
  const owner = input.agentId ? service.agent(input.agentId) : null;

  if (owner && owner.mcpServers.length >= 30)
    throw new InvalidInput({
      message: `${owner.name} already uses 30 MCP servers`,
    });
  const server = exec(McpServerRepository.use((r) => r.create(input)));

  storeSecret(exec, `mcp:${server.id}`, input.token);
  storeSecret(exec, clientSecretKey(server.id), input.oauthClientSecret);

  if (owner)
    exec(
      AgentRepository.use((r) =>
        r.update(owner.id, {
          mcpServers: [...owner.mcpServers, server.id],
        }),
      ),
    );

  return server;
};

/** The account's MCP servers, and the OAuth sign-in flow for the ones that need it. */
const registerMcpAuthRoutes = (options: McpServerRoutesOptions) => {
  const { register, secrets, integrations } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  const describe = (server: MCPServer) =>
    describeServer(exec, secrets, integrations, server);

  register(routes.mcpServers, (c) =>
    c.json(exec(McpServerRepository.use((r) => r.list)).map(describe), 200),
  );
  // OAuth sign-in: the client opens the returned URL, then posts back the code, state and issuer it receives.
  register(routes.oauth, async (c) => {
    const { redirectUri } = oauthInput.parse(await c.req.json());

    return c.json(
      await startAuthorization(
        secrets,
        mcpServer(exec, c.req.param("id")),
        redirectUri,
        options.oauthClient,
      ),
      200,
    );
  });
  register(routes.oauthCallback, async (c) => {
    const { code, state, iss } = oauthCallbackInput.parse(await c.req.json());

    const server = mcpServer(exec, c.req.param("id"));
    await finishAuthorization(
      secrets,
      server,
      code,
      state,
      iss,
      options.oauthClient,
    );

    if (integrations)
      await Effect.runPromise(integrations.disconnect(server.id));

    return c.json(describe(server), 200);
  });
  register(routes.deleteOauth, async (c) => {
    const server = mcpServer(exec, c.req.param("id"));
    signOut(secrets, server.id);

    if (integrations)
      await Effect.runPromise(integrations.disconnect(server.id));

    return c.json(describe(server), 200);
  });
};

/** Adding, editing, and deleting MCP servers. */
const registerMcpServerEditRoutes = (options: McpServerRoutesOptions) => {
  const { register, service, secrets, integrations } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.createMcpServer, async (c) => {
    const input = mcpCreateInput.parse(await c.req.json());

    return c.json(addMcpServer(exec, service, input), 201);
  });
  register(routes.updateMcpServer, async (c) => {
    const old = mcpServer(exec, c.req.param("id"));
    const input = mcpInput.parse({ ...old, ...(await c.req.json()) });

    storeSecret(exec, `mcp:${old.id}`, input.token);

    const secretChanged =
      input.oauthClientSecret !== undefined &&
      input.oauthClientSecret !==
        exec(SecretRepository.use((r) => r.get(clientSecretKey(old.id))));

    storeSecret(exec, clientSecretKey(old.id), input.oauthClientSecret);

    // Tokens belong to the client that obtained them, so another client signs in again.
    if (secretChanged || (input.oauthClientId ?? null) !== old.oauthClientId) {
      signOut(secrets, old.id);

      if (integrations)
        await Effect.runPromise(integrations.disconnect(old.id));
    }

    return c.json(
      exec(
        McpServerRepository.use((r) =>
          r.update(old.id, {
            ...input,
            oauthClientId: input.oauthClientId ?? null,
          }),
        ),
      ),
      200,
    );
  });
  register(routes.deleteMcpServer, (c) => {
    if (!exec(McpServerRepository.use((r) => r.delete(c.req.param("id")))))
      throw new NotFound({ message: "MCP server not found" });
    exec(SecretRepository.use((r) => r.delete(`mcp:${c.req.param("id")}`)));
    exec(
      SecretRepository.use((r) => r.delete(clientSecretKey(c.req.param("id")))),
    );
    signOut(secrets, c.req.param("id"));

    return c.body(null, 204);
  });
};

/** The MCP server routes, in the order the contract document lists them. */
export function registerMcpServerRoutes(options: McpServerRoutesOptions) {
  registerMcpAuthRoutes(options);
  registerMcpServerEditRoutes(options);
}
