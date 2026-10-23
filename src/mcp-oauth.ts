import type { AuthProvider } from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
} from "@earendil-works/pi-mcp/oauth";
import { AppError, type MCPServer } from "./domain";
import type { Store } from "./store";

/**
 * A server's OAuth state as pi-mcp keeps it (client registration, tokens, PKCE verifier, state),
 * plus the redirect URL it was registered for. Stored with the encrypted credentials.
 */
type SavedOAuth = { redirectUrl: string; state: McpOAuthState };

const credentialKey = (serverId: string) => `mcp-oauth:${serverId}`;

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

function read(store: Store, serverId: string): SavedOAuth | undefined {
  const raw = store.getCredential(credentialKey(serverId));

  if (!raw) return undefined;

  try {
    // SAFETY: write() serializes SavedOAuth under this private credential key;
    // only this module writes that key, and malformed JSON is rejected below.
    return JSON.parse(raw) as SavedOAuth;
  } catch {
    return undefined;
  }
}

function write(store: Store, serverId: string, saved: SavedOAuth) {
  store.setCredential(credentialKey(serverId), JSON.stringify(saved));
}

export function hasOAuthTokens(store: Store, serverId: string) {
  return Boolean(read(store, serverId)?.state.tokens?.access_token);
}

export function signOut(store: Store, serverId: string) {
  store.deleteCredential(credentialKey(serverId));
}

function provider(
  store: Store,
  server: MCPServer,
  redirectUrl: string,
  onRedirect: (url: URL) => void,
  document: ClientDocument | undefined,
) {
  const stateStore: McpOAuthStateStore = {
    load: () => read(store, server.id)?.state,
    save: (state) => write(store, server.id, { redirectUrl, state }),
  };

  return new McpOAuthProvider({
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
  });
}

/**
 * The auth a live connection uses: pi-mcp sends the access token and refreshes it. When the
 * refresh fails it cannot open a browser, so the call fails and the owner signs in again.
 */
export function connectionAuth(
  store: Store,
  server: MCPServer,
  document?: ClientDocument,
): AuthProvider | undefined {
  const saved = read(store, server.id);

  if (!saved?.state.tokens?.access_token) return undefined;

  return adaptOAuthProvider(
    provider(store, server, saved.redirectUrl, () => undefined, document),
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
function registrationHint(document: ClientDocument | undefined) {
  if (!document)
    return "If it supports client metadata documents, set CRUMBLE_PUBLIC_URL to the server's public https address; otherwise add the server with a token";

  const web = document.redirectUris[0]!.replace(/\/oauth\/callback$/, "");

  return `Sign in from ${web}, or from the Mac or iOS app, if it supports client metadata documents; otherwise add the server with a token`;
}

/**
 * Discovers the server's authorization server, registers Crumble for `redirectUrl`, and returns the
 * URL the owner signs in at, or `authorized` when the saved tokens still work.
 */
export async function startAuthorization(
  store: Store,
  server: MCPServer,
  redirectUrl: string,
  document?: ClientDocument,
): Promise<{ authorizationUrl: string } | { authorized: true }> {
  const saved = read(store, server.id);

  // A registration names its redirect URL and server, so a change of either starts over.
  if (
    !saved ||
    saved.redirectUrl !== redirectUrl ||
    saved.state.serverUrl !== server.url
  )
    write(store, server.id, { redirectUrl, state: { serverUrl: server.url } });
  let authorizationUrl: URL | undefined;

  const oauth = provider(
    store,
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
      unavailable(server, `${error.message}. ${registrationHint(document)}`);

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
  store: Store,
  server: MCPServer,
  code: string,
  state: string,
  iss?: string,
  document?: ClientDocument,
) {
  const saved = read(store, server.id);

  if (!saved?.state.oauthState || saved.state.oauthState !== state)
    throw new AppError(400, "This sign-in has expired; start again");

  const oauth = provider(
    store,
    server,
    saved.redirectUrl,
    () => undefined,
    document,
  );

  let result;

  try {
    result = await authorizeMcp(oauth, {
      serverUrl: server.url,
      authorizationCode: code,
      iss,
    });
  } catch (error) {
    unavailable(server, error, "finish");
  }

  if (result !== "AUTHORIZED")
    throw new AppError(400, `${server.name} did not accept the sign-in`);
  // The state and verifier answer one attempt only.
  const done = read(store, server.id)!;
  const { oauthState: _state, codeVerifier: _verifier, ...rest } = done.state;
  write(store, server.id, { ...done, state: rest });
}
