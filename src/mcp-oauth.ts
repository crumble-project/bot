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
) {
  const stateStore: McpOAuthStateStore = {
    load: () => read(store, server.id)?.state,
    save: (state) => write(store, server.id, { redirectUrl, state }),
  };

  return new McpOAuthProvider({
    serverUrl: server.url,
    redirectUrl,
    clientMetadata: {
      client_name: "Crumble",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
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
): AuthProvider | undefined {
  const saved = read(store, server.id);

  if (!saved?.state.tokens?.access_token) return undefined;

  return adaptOAuthProvider(
    provider(store, server, saved.redirectUrl, () => undefined),
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

/**
 * Discovers the server's authorization server, registers Crumble for `redirectUrl`, and returns the
 * URL the owner signs in at, or `authorized` when the saved tokens still work.
 */
export async function startAuthorization(
  store: Store,
  server: MCPServer,
  redirectUrl: string,
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

  const oauth = provider(store, server, redirectUrl, (url) => {
    authorizationUrl = url;
  });

  let result;

  try {
    result = await authorizeMcp(oauth, { serverUrl: server.url });
  } catch (error) {
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
) {
  const saved = read(store, server.id);

  if (!saved?.state.oauthState || saved.state.oauthState !== state)
    throw new AppError(400, "This sign-in has expired; start again");
  const oauth = provider(store, server, saved.redirectUrl, () => undefined);
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
