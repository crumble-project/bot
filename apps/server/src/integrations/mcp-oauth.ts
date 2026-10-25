import type { AuthProvider } from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  type McpOAuthProviderOptions,
  type McpOAuthState,
  type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";
import { AppError, type MCPServer } from "../shared/domain";
import { Context, Effect, Layer } from "effect";
import { SecretRepository } from "../credentials/secret-repository";
import { appErrors } from "../shared/app-errors";
import { runnerOf, type Runner } from "../shared/runner";

/**
 * A server's OAuth state as pi-mcp keeps it (client registration, tokens, PKCE verifier, state),
 * plus the redirect URL it was registered for. Stored with the encrypted credentials.
 */
type SavedOAuth = {
  redirectUrl: string;
  state: McpOAuthState;
  /** The owner's OAuth app the state belongs to; null when Crumble registered or used its document. */
  clientId?: string | null;
};

const credentialKey = (serverId: string) => `mcp-oauth:${serverId}`;

/** Where the client secret of the owner's OAuth app for an MCP server is stored, encrypted. */
export const clientSecretKey = (serverId: string) =>
  `mcp-oauth-client:${serverId}`;

/**
 * Uses the owner's OAuth app as the client. It sends its secret in the token request body, which GitHub
 * documents and every authorization server that takes client secrets accepts, rather than pi-mcp's default of HTTP Basic.
 */
class OwnerClientProvider extends McpOAuthProvider {
  constructor(
    options: McpOAuthProviderOptions,
    private readonly client: {
      client_id: string;
      client_secret?: string;
      token_endpoint_auth_method: "client_secret_post" | "none";
    },
  ) {
    super(options);
  }

  override async clientInformation() {
    return this.client;
  }
}

const CLIENT_METADATA = {
  client_name: "Crumble",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

/** Where a server with a public address serves its OAuth Client ID Metadata Document. */
export const CLIENT_DOCUMENT_PATH = "/oauth/client-metadata.json";

/** The native apps' sign-in callbacks; their system sign-in sheets watch these schemes. */
const NATIVE_REDIRECTS = [
  "ng.crumbli.mac:/oauth/callback",
  "ng.crumbli.mac.dev:/oauth/callback",
  "dev.crumble.ios:/oauth/callback",
];

/**
 * Crumble's OAuth Client ID Metadata Document (CIMD): its https URL is the client ID, so authorization
 * servers without dynamic registration accept Crumble by fetching it. Only a publicly reachable server has one.
 */
export type ClientDocument = { url: string; redirectUris: string[] };

export function clientDocument(publicUrl: URL): ClientDocument {
  const base = publicUrl.href.replace(/\/+$/, "");

  return {
    url: `${base}${CLIENT_DOCUMENT_PATH}`,
    redirectUris: [`${base}/ui/oauth/callback`, ...NATIVE_REDIRECTS],
  };
}

/** The document an authorization server fetches; its `client_id` must be its own URL. */
export const clientDocumentBody = (document: ClientDocument) => ({
  client_id: document.url,
  ...CLIENT_METADATA,
  redirect_uris: document.redirectUris,
});

/** Encrypted values by key, as the OAuth flows read and write them synchronously. */
export type SecretStorage = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
};

export const secretStorage = (
  run: Runner<SecretRepository>,
): SecretStorage => ({
  get: (key) =>
    run.runSync(SecretRepository.use((secrets) => secrets.get(key))),
  set: (key, value) =>
    run.runSync(SecretRepository.use((secrets) => secrets.set(key, value))),
  delete: (key) =>
    run.runSync(SecretRepository.use((secrets) => secrets.delete(key))),
});

function read(
  storage: SecretStorage,
  serverId: string,
): SavedOAuth | undefined {
  const raw = storage.get(credentialKey(serverId));

  if (!raw) return undefined;

  try {
    // SAFETY: write() serializes SavedOAuth under this private credential key;
    // only this module writes that key, and malformed JSON is rejected below.
    return JSON.parse(raw) as SavedOAuth;
  } catch {
    return undefined;
  }
}

function write(storage: SecretStorage, serverId: string, saved: SavedOAuth) {
  storage.set(credentialKey(serverId), JSON.stringify(saved));
}

export function hasOAuthTokens(storage: SecretStorage, serverId: string) {
  return Boolean(read(storage, serverId)?.state.tokens?.access_token);
}

export function signOut(storage: SecretStorage, serverId: string) {
  storage.delete(credentialKey(serverId));
}

function provider(
  storage: SecretStorage,
  server: MCPServer,
  redirectUrl: string,
  onRedirect: (url: URL) => void,
  document: ClientDocument | undefined,
) {
  const stateStore: McpOAuthStateStore = {
    load: () => read(storage, server.id)?.state,
    save: (state) =>
      write(storage, server.id, {
        redirectUrl,
        state,
        clientId: server.oauthClientId,
      }),
  };

  const options: McpOAuthProviderOptions = {
    serverUrl: server.url,
    redirectUrl,
    clientMetadata: CLIENT_METADATA,
    // Without dynamic registration, identify by the document when the server fetches them and it lists this callback.
    clientMetadataDocument: (metadata) =>
      document &&
      metadata?.client_id_metadata_document_supported &&
      document.redirectUris.includes(redirectUrl)
        ? { url: document.url, redirectUrl }
        : undefined,
    store: stateStore,
    onRedirect,
  };

  if (!server.oauthClientId) return new McpOAuthProvider(options);

  const secret = storage.get(clientSecretKey(server.id));

  return new OwnerClientProvider(options, {
    client_id: server.oauthClientId,
    ...(secret && { client_secret: secret }),
    token_endpoint_auth_method: secret ? "client_secret_post" : "none",
  });
}

/**
 * The auth a live connection uses: pi-mcp sends the access token and refreshes it. When the
 * refresh fails it cannot open a browser, so the call fails and the owner signs in again.
 */
export function connectionAuth(
  storage: SecretStorage,
  server: MCPServer,
  document?: ClientDocument,
): AuthProvider | undefined {
  const saved = read(storage, server.id);

  if (!saved?.state.tokens?.access_token) return undefined;

  return adaptOAuthProvider(
    provider(storage, server, saved.redirectUrl, () => undefined, document),
  );
}

function unavailable(
  server: MCPServer,
  cause: unknown,
  step: "start" | "finish" = "start",
): never {
  if (cause instanceof AppError) throw cause;
  const reason = cause instanceof Error ? cause.message : String(cause);
  throw new AppError(
    400,
    `${server.name} could not ${step} OAuth sign-in: ${reason}`,
  );
}

/** What to do when an authorization server registers no clients: CIMD needs a public address, or a token instead. */
function registrationHint(
  document: ClientDocument | undefined,
  redirectUrl: string,
) {
  if (!document)
    return "If it supports client metadata documents, set CRUMBLE_PUBLIC_URL to the server's public https address; otherwise add the server with a token";

  // The document already covered this sign-in, so the authorization server accepts neither registration method.
  if (document.redirectUris.includes(redirectUrl))
    return "It doesn't accept client metadata documents either, so add the server with a token";

  const web = document.redirectUris[0]!.replace(/\/oauth\/callback$/, "");

  return `Sign in from ${web}, or from the Mac or iOS app, if it supports client metadata documents; otherwise add the server with a token`;
}

/**
 * Discovers the server's authorization server, registers Crumble for `redirectUrl`, and returns the
 * URL the owner signs in at, or `authorized` when the saved tokens still work.
 */
export async function startAuthorization(
  storage: SecretStorage,
  server: MCPServer,
  redirectUrl: string,
  document?: ClientDocument,
): Promise<{ authorizationUrl: string } | { authorized: true }> {
  const saved = read(storage, server.id);

  // A registration names its redirect URL and server, so a change of either starts over.
  if (
    !saved ||
    saved.redirectUrl !== redirectUrl ||
    saved.state.serverUrl !== server.url ||
    (saved.clientId ?? null) !== server.oauthClientId
  )
    write(storage, server.id, {
      redirectUrl,
      state: { serverUrl: server.url },
      clientId: server.oauthClientId,
    });
  let authorizationUrl: URL | undefined;

  const oauth = provider(
    storage,
    server,
    redirectUrl,
    (url) => {
      authorizationUrl = url;
    },
    document,
  );

  let result;

  try {
    result = await authorizeMcp(oauth, { serverUrl: server.url });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("does not support dynamic client registration")
    )
      unavailable(
        server,
        `${error.message}. ${registrationHint(document, redirectUrl)}`,
      );

    unavailable(server, error);
  }

  if (result === "AUTHORIZED") return { authorized: true };

  if (!authorizationUrl) unavailable(server, "no authorization URL");

  return { authorizationUrl: authorizationUrl.toString() };
}

/**
 * Exchanges the code from the owner's sign-in for tokens, after checking it answers this attempt.
 * `iss` is the issuer the callback carried, which servers that promise one must send (RFC 9207).
 */
export async function finishAuthorization(
  storage: SecretStorage,
  server: MCPServer,
  code: string,
  state: string,
  iss?: string,
  document?: ClientDocument,
) {
  const saved = read(storage, server.id);

  if (!saved?.state.oauthState || saved.state.oauthState !== state)
    throw new AppError(400, "This sign-in has expired; start again");

  const oauth = provider(
    storage,
    server,
    saved.redirectUrl,
    () => undefined,
    document,
  );

  let result;

  try {
    const flow = { serverUrl: server.url, authorizationCode: code };

    result = await authorizeMcp(
      oauth,
      iss === undefined ? flow : { ...flow, iss },
    );
  } catch (error) {
    unavailable(server, error, "finish");
  }

  if (result !== "AUTHORIZED")
    throw new AppError(400, `${server.name} did not accept the sign-in`);
  // The state and verifier answer one attempt only.
  const done = read(storage, server.id)!;
  const { oauthState: _state, codeVerifier: _verifier, ...rest } = done.state;
  write(storage, server.id, { ...done, state: rest });
}

/** OAuth sign-in to MCP servers, with tokens and registrations encrypted among the account's secrets. */
export class McpOAuth extends Context.Service<
  McpOAuth,
  {
    readonly hasTokens: (serverId: string) => Effect.Effect<boolean>;
    readonly signOut: (serverId: string) => Effect.Effect<void>;
    /** The auth a live connection uses, when the server has saved tokens. */
    readonly connectionAuth: (
      server: MCPServer,
      document?: ClientDocument,
    ) => Effect.Effect<AuthProvider | undefined>;
    readonly start: (
      server: MCPServer,
      redirectUrl: string,
      document?: ClientDocument,
    ) => Effect.Effect<
      { authorizationUrl: string } | { authorized: true },
      AppError
    >;
    readonly finish: (
      server: MCPServer,
      code: string,
      state: string,
      iss?: string,
      document?: ClientDocument,
    ) => Effect.Effect<void, AppError>;
  }
>()("crumble/integrations/McpOAuth") {
  static readonly layer = Layer.effect(
    McpOAuth,
    Effect.gen(function* () {
      const storage = secretStorage(
        runnerOf(yield* Effect.context<SecretRepository>()),
      );

      return McpOAuth.of({
        hasTokens: (serverId) =>
          Effect.sync(() => hasOAuthTokens(storage, serverId)),
        signOut: (serverId) => Effect.sync(() => signOut(storage, serverId)),
        connectionAuth: (server, document) =>
          Effect.sync(() => connectionAuth(storage, server, document)),
        start: (server, redirectUrl, document) =>
          appErrors(
            Effect.tryPromise(() =>
              startAuthorization(storage, server, redirectUrl, document),
            ),
          ),
        finish: (server, code, state, iss, document) =>
          appErrors(
            Effect.tryPromise(() =>
              finishAuthorization(storage, server, code, state, iss, document),
            ),
          ),
      });
    }),
  );
}
