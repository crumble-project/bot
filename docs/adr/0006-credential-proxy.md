# Credential proxy

- Status: Accepted

How a bot's credentials ([feature 0007](https://github.com/crumble-project/spec/blob/main/features/0007-credentials.md)) reach the hosts they are for while the workspace holds only placeholders. Research: [workspace secrets](../research/workspace-secrets.md).

## Decision

- **One interception point, inside the workspace proxy.** `startWorkspaceProxy` hands a TLS connection to a `WorkspaceInterceptor` when the bot has a credential for its server name, and tunnels everything else as before. The interceptor (`src/credential-proxy.ts`) is created per workspace from that bot's credentials only, so a placeholder sent from another bot's workspace, or to another host, stays a placeholder. Microsandbox already routes every guest connection through this proxy; Railway reaches it over the exec stream (milestone 3).
- **A certificate authority per bot** (`src/credential-authority.ts`), an ECDSA P-256 key encrypted in the store next to its certificate, created on first boot and trusted by the guest at `/usr/local/share/ca-certificates/crumble-credentials.crt`. Host certificates are made on demand, cached per process, and valid for 7 days. They carry the key identifiers strict verifiers require (Python 3.13 and later).
- **pkijs builds certificates.** Node's crypto signs but cannot write X.509, and the server image has no `openssl` binary. Rejected: `@peculiar/x509`, which needs a global `reflect-metadata` polyfill, and `node-forge`, which has no EC keys.
- **Node's HTTP stack relays requests.** The proxy terminates TLS with a server-side `TLSSocket`, feeds it to an unlistened `http.Server`, and forwards each request with `https.request`, so framing, keep-alive, and chunked bodies need no parser of our own. It offers only `http/1.1` in ALPN; clients fall back from HTTP/2.
- **Swap in headers and the query string; scrub responses.** Placeholders are replaced in header values, inside HTTP Basic credentials, and in the request target; bodies are left alone. Requests ask for `Accept-Encoding: identity`, and the value is replaced by its placeholder in response headers and bodies as they stream, so an echoing API cannot return it. Values shorter than 8 characters are not scrubbed.
- **Public upstream addresses only.** The upstream connection resolves the host again and keeps only public addresses, so a credential host that resolves into the server's network gets nothing.

## Consequences

- Each use is recorded with method, host, path, and status, but not the coding job: jobs share one workspace and its connections carry no job identity. The owner accepted this on 2026-10-24.
- WebSocket upgrades and HTTP/2-only clients do not work on credential hosts.
- Bun stalls a server-side TLS handshake when the wrapped socket is resumed, so the proxy leaves reading to the `TLSSocket`.
