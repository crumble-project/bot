# API and automation boundaries

- Status: Accepted

## Tenant request routing

The server authenticates account API requests before forwarding them to the corresponding tenant runtime. A desktop viewer ticket is a credential because a web view cannot send the owner's session; when the request has a session, its account remains authoritative. Voice gateway requests use their bearer token to identify the account and do not consult browser sessions. Keep these credential paths separate and return the same refusal response for an unknown account and an invalid voice token.

Admin routes are served by the admin API, not the tenant's Better Auth plugin. The plugin's admin endpoints are hidden to prevent tenant-level impersonation paths. Route registration keeps API paths ahead of the UI wildcard.

## Startup and resource lifetime

An account's runtime layers are acquired so shutdown disposes outer consumers before the resources they depend on; account recovery and service start happen only after API construction. Workspace resources are removed when the account is deleted, while cleanup failures are logged rather than rejecting deletion.

Group-chat migration may open a cold WAL database for inventory. Even that connection can need writable WAL sidecars, so it must not be opened read-only solely because the migration's query is read-only.

## Authentication compatibility

Invite operations in Better Auth signup hooks resolve the current transaction adapter for each query. Queries made through the base adapter while a signup transaction is open can deadlock SQLite waiting on that same transaction.

Account data is stored under a validated account ID; the ID must never escape the account data root. Server settings are decoded independently by key using that setting's own schema. A missing key uses its default; an unreadable value falls back only that setting, with sign-up closed, so one malformed or version-skewed value cannot reset neighboring settings.

Passkey relying-party IDs cannot be IP addresses. For loopback origins, map `127.0.0.1` and `::1` to `localhost`, retaining the port in the origin. A server upgraded from before roles existed promotes its oldest account only when no admin is present.
