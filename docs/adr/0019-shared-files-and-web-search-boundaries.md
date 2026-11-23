# Shared, file, and web-search boundaries

- Status: Accepted

This record preserves consequential rationale removed from implementation comments during the comment cleanup. Workspace lifecycle, machine persistence, and proxy/tunnel decisions remain in [ADR 0005](0005-railway-workspaces.md), [ADR 0010](0010-workspace-machine-lifecycle.md), and [ADR 0011](0011-workspace-proxy-and-tunnel-boundaries.md); this record does not restate them.

## Decisions

- Treat request, entry, account, job, and vendor identifiers as persisted/wire-format data. Format or key changes can break durable lookup, idempotency, contracts, or account isolation; change them deliberately and compatibly. Durable record IDs remain non-negative safe integers, and entry references distinguish malformed values from references owned by another bot.
- Treat shared limits used by contract `maxLength` declarations and tool schemas as wire constraints: changing one alters accepted API input. `required()` is the explicit boundary for invariants TypeScript cannot prove; it throws the named invariant error rather than allowing a later, less useful missing-value failure.
- Interpret stored memory sources as nullable for records created before source tracking. Host patterns beginning with `*.` match subdomains, not the base hostname. Keep chart series color tokens stable because native clients consume them.
- Parse composite request IDs using the final field for details that may themselves contain colons. Validate durable IDs as non-negative safe integers; for owner-scoped entry references, distinguish a foreign owner from malformed input.
- Keep secret-key writes crash-safe: write and sync a temporary file before rename, sync the containing directory where supported, and retain the plaintext key until wrapped-key verification succeeds. Refuse startup when persisted encrypted data exists but its key is missing or cannot be unwrapped. Windows lacks the directory-sync operation used here.
- Restrict web-search destinations to globally routable addresses. The provider resolves hostnames itself, so validation must happen on the provider's resolution path rather than assuming Crumble controls the connection; transition and mapped IPv6 forms are refused as well.
- Keep file extraction bounded and settle worker/process cleanup before returning; a failed read is already the primary error and cleanup must not replace it. Recognize tagged file-size failures by their tag/properties, not `instanceof`, at the asynchronous stream boundary.
- Recognize Zod parse errors by their `name` and `issues`, and schemas by `parse`/`safeParse`, rather than relying on `instanceof` across package boundaries.
- Keep outside-call-only context separate from ordinary bot chat, so call content does not enter the bot's normal conversation context.
- Preserve useful diagnostics for code outside Effect by rendering errors with their causes. Effect-managed code uses Effect logging.
- Supply explicit guest environment variables for tools that do not honor the common CA/proxy variables: Debian Git uses `GIT_SSL_CAINFO`, and Node fetch requires `NODE_USE_ENV_PROXY` for proxy environment support.
- Keep credential-use history intact when restructuring credential storage. SQLite foreign-key cascades mean rebuilding the credential table is not a neutral migration operation.

These decisions were verified against the corresponding implementations. The [infrastructure audit summary](../comment-audits/infrastructure.md) explains why detailed classifications are retained privately under the security policy.