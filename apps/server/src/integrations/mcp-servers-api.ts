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
import { Secrets } from "../password-managers/secrets";
import type { MCPServer, SecretInput } from "../shared/domain";
import { InvalidInput, NotFound } from "../shared/errors";
import type { Runner } from "../shared/runner";
import type { McpIntegrations } from "./integrations";
import type { ClientDocument } from "./mcp-oauth";
import {
  clientSecretKey,
  finishAuthorization,
  mcpTokenKey,
  hasOAuthTokens,
  signOut,
  startAuthorization,
  type SecretStorage,
} from "./mcp-oauth";
import { McpServerRepository } from "./mcp-server-repository";

type Services = AgentRepository | McpServerRepository | Secrets;

type Exec = Runner<Services>["runSync"];

type McpServerRoutesOptions = {
  register: Register;
  service: BotsAccess;
  /** Runs the repository effects the MCP server routes read and write. */
  run: Runner<Services>;
  secrets: SecretStorage;
  integrations?: McpIntegrations["Service"] | undefined;
  /** The server's OAuth client metadata document, when it has a public address. */
  oauthClient?: ClientDocument | undefined;
};

/** The server with its secrets' status, never their values. */
const withSecrets = (exec: Exec, server: MCPServer) => ({
  ...server,
  token: exec(Secrets.use((s) => s.status(mcpTokenKey(server.id)))),
  oauthClientSecret: exec(
    Secrets.use((s) => s.status(clientSecretKey(server.id))),
  ),
});

/** The server as the owner's client sees it: its auth state plus the last connection failure. */
const describeServer = (
  exec: Exec,
  secrets: SecretStorage,
  integrations: McpIntegrations["Service"] | undefined,
  server: MCPServer,
) => {
  const described = withSecrets(exec, server);

  const auth = hasOAuthTokens(secrets, server.id)
    ? "oauth"
    : described.token.configured
      ? "token"
      : "none";

  return {
    ...described,
    auth,
    authenticated: auth !== "none",
    error: integrations?.failure(server.id) ?? null,
  } as const;
};

const mcpServer = (exec: Exec, id: string) => {
  const server = exec(McpServerRepository.use((r) => r.get(id)));

  if (!server) throw new NotFound({ message: "MCP server not found" });

  return server;
};

/** Saves, or with null removes, one of the server's secrets; returns whether one was sent. */
const storeSecret = async (
  run: Runner<Services>,
  key: string,
  input: SecretInput | null | undefined,
) => {
  if (input === undefined) return false;

  await run.runPromise(
    Secrets.use((s) =>
      input === null ? Effect.asVoid(s.delete(key)) : s.save(key, input),
    ),
  );

  return true;
};

/** Stores a new server's secrets; one that can't be saved, such as an unreadable reference, takes the server with it. */
const storeNewSecrets = async (
  run: Runner<Services>,
  server: MCPServer,
  input: z.output<typeof mcpCreateInput>,
) => {
  try {
    await storeSecret(run, mcpTokenKey(server.id), input.token);
    await storeSecret(run, clientSecretKey(server.id), input.oauthClientSecret);
  } catch (error) {
    run.runSync(McpServerRepository.use((r) => r.delete(server.id)));
    run.runSync(Secrets.use((s) => s.delete(mcpTokenKey(server.id))));
    throw error;
  }
};

/** Adding a server, storing its secrets, and letting the bot that owns it use it right away. */
const addMcpServer = async (
  run: Runner<Services>,
  service: BotsAccess,
  input: z.output<typeof mcpCreateInput>,
) => {
  const exec: Exec = (effect) => run.runSync(effect);
  const owner = input.agentId ? service.agent(input.agentId) : null;

  if (owner && owner.mcpServers.length >= 30)
    throw new InvalidInput({
      message: `${owner.name} already uses 30 MCP servers`,
    });

  const server = exec(McpServerRepository.use((r) => r.create(input)));

  await storeNewSecrets(run, server, input);

  if (owner)
    exec(
      AgentRepository.use((r) =>
        r.update(owner.id, {
          mcpServers: [...owner.mcpServers, server.id],
        }),
      ),
    );

  return withSecrets(exec, server);
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

/**
 * Saves the secrets an edit sends. A new token, or another OAuth app, closes the open connection; another OAuth app
 * also signs the server out, since tokens belong to the client that obtained them.
 */
const updateSecrets = async (
  options: McpServerRoutesOptions,
  old: MCPServer,
  input: z.output<typeof mcpInput>,
) => {
  const tokenChanged = await storeSecret(
    options.run,
    mcpTokenKey(old.id),
    input.token,
  );

  const appChanged =
    (await storeSecret(
      options.run,
      clientSecretKey(old.id),
      input.oauthClientSecret,
    )) || (input.oauthClientId ?? null) !== old.oauthClientId;

  if (appChanged) signOut(options.secrets, old.id);

  if ((tokenChanged || appChanged) && options.integrations)
    await Effect.runPromise(options.integrations.disconnect(old.id));
};

/** Adding, editing, and deleting MCP servers. */
const registerMcpServerEditRoutes = (options: McpServerRoutesOptions) => {
  const { register, service, secrets } = options;
  const exec: Exec = (effect) => options.run.runSync(effect);

  register(routes.createMcpServer, async (c) => {
    const input = mcpCreateInput.parse(await c.req.json());

    return c.json(await addMcpServer(options.run, service, input), 201);
  });
  register(routes.updateMcpServer, async (c) => {
    const old = mcpServer(exec, c.req.param("id"));
    const input = mcpInput.parse({ ...old, ...(await c.req.json()) });

    await updateSecrets(options, old, input);

    const updated = exec(
      McpServerRepository.use((r) =>
        r.update(old.id, {
          ...input,
          oauthClientId: input.oauthClientId ?? null,
        }),
      ),
    );

    return c.json(updated && withSecrets(exec, updated), 200);
  });
  register(routes.deleteMcpServer, (c) => {
    const id = c.req.param("id");

    if (!exec(McpServerRepository.use((r) => r.delete(id))))
      throw new NotFound({ message: "MCP server not found" });
    exec(Secrets.use((s) => s.delete(mcpTokenKey(id))));
    exec(Secrets.use((s) => s.delete(clientSecretKey(id))));
    signOut(secrets, id);

    return c.body(null, 204);
  });
};

/** The MCP server routes, in the order the contract document lists them. */
export function registerMcpServerRoutes(options: McpServerRoutesOptions) {
  registerMcpAuthRoutes(options);
  registerMcpServerEditRoutes(options);
}
