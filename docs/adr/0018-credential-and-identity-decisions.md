# Credential and identity decisions

- Status: Accepted
- Supersedes: the credential and GitHub identity rationale formerly kept in source comments. Credential-proxy mechanics remain in [ADR 0006](0006-credential-proxy.md).

## Decisions

### Keep credential values out of workspaces

The owner stores a credential for explicit hosts. A workspace receives a per-credential placeholder, not its value. The workspace proxy reads the value only when a request header contains that placeholder and the request host is granted. The value is replaced in headers, including Basic authorization, but not in URLs or request bodies. This limits disclosure through request logs and storage and avoids silently rewriting arbitrary payloads. Tools that bypass the HTTPS proxy receive no value.

The proxy terminates TLS with a certificate authority unique to the bot. Its private key is encrypted in the server database; the bot's workspace trusts the authority. The authority can sign leaf host certificates, not another authority. The proxy resolves upstream hosts again and forwards only to public addresses, preventing a credential host from using the proxy to reach server-private networks. Responses request identity encoding and scrub credential values from headers and streamed bodies; values shorter than eight characters are not scrubbed because matching them could corrupt ordinary response data. Request-use records omit the query string.

The relay supports HTTP/1.1. HTTP/2 and WebSocket upgrades need separate relay behavior and are not forwarded by this implementation. The TLS socket owns client reads during the handshake because resuming the wrapped socket stalls Bun's handshake.

### Keep stored and external secrets distinct

Stored values are encrypted and read only when needed. Password-manager references are read through a signed-in client scoped to that manager and cached in memory. A fresh value is reused for an hour; refresh begins after 55 minutes. If the manager is unreachable, a cached value can remain usable for up to two hours. Other read failures, which can indicate a missing or revoked value, discard the cache. Volatile values such as computed one-time codes bypass this cache. Disconnect and reference changes invalidate cached values and interrupt reads that still hold a client.

Credential and login listings expose metadata and configuration status, not decrypted values. A credential's placeholder remains stable when its host grant changes. Password-manager references are checked before saving; multi-field login writes are verified before any are stored.

### Separate GitHub App and machine identities

A bot can use an installed GitHub App for repositories under that App's account. The server mints installation tokens on use and exposes them to Git tooling through the same `GH_TOKEN` placeholder mechanism as other credentials. When the owner authorizes through an App, bots assigned to it use the owner's OAuth token; otherwise they use the App's installation identity. A machine account supplies the fallback identity for requests without a matching App account, including repositories outside installed App accounts.

Machine-account signing keys and App private keys remain server-side. Git asks a guest helper to request a signature; the key is not copied into the workspace. GitHub App commits made through GitHub's API do not require that local signer. App permissions omit `workflows`, and App-created links use the public documentation site rather than the server origin.

OAuth state is single-use and time-limited. Owner access and refresh tokens are encrypted; refreshes are serialized because GitHub rotates refresh tokens. Local sign-out commits before remote grant revocation, so a slow remote call cannot restore local authorization. GitHub identities are selected by repository owner where the request path provides one; owner-less API requests use the machine identity when configured, then the default installed App.

## Consequences

- A placeholder in a URL or body is not transformed. A client that requires a real credential there is unsupported by this mechanism.
- Short values are not removed from responses. This is an explicit trade-off against corrupting arbitrary response content.
- Password-manager stale values are retained only for unreachability, not for errors that could indicate revocation.
- Credential-proxy request logs omit query parameters, but record method, host, status, and path. Workspace/job attribution is unavailable at this shared proxy boundary; see [ADR 0006](0006-credential-proxy.md).
- Bitwarden's SDK error semantics and UUID casing are not established by the adapter's local tests. [Issue #156](https://github.com/crumble-project/bot/issues/156) tracks verification of those mappings; they are not architectural guarantees.
