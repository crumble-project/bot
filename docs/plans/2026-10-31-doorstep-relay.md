# Doorstep implementation plan

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Build Doorstep, a self-hostable webhook relay that holds incoming webhooks at per-source addresses and forwards them to a consumer server over that server's own outbound WebSocket.
**Architecture:** One TypeScript codebase on Hono. Runtime-independent core (routes, protocol, an account-scoped store interface) with two runtimes: Cloudflare Workers with one Durable Object per account (SQLite storage, hibernating WebSockets), and Bun with `bun:sqlite`, shipped as a single binary. The relay is a dumb pipe: it never parses, verifies, or routes by payload content.
**Source:** design discussion of 2026-10-31 (Crumble event triggers); this file is the only written record.

Repo description (for GitHub): "Self-hostable webhook relay: holds incoming webhooks at per-source addresses and forwards them to your server over its own outbound connection. No public address needed."

## Decisions

- **Separate repository**, not inside Crumble: useful beyond Crumble, own release cycle, own license; the wire protocol is the only contract with Crumble.
- **Name:** Doorstep (deliveries left at the door while nobody's home). Not yet checked for collisions on GitHub, npm, and domains.
- **TypeScript + Hono, not Go:** Go runs on Workers only through WebAssembly, which fits Durable Objects poorly; Hono runs the same app on Workers and Bun; `bun build --compile` gives Go's single-binary deployment.
- **One address per source**, `/h/<accountId>/<sourceSecret>`: routing is trivial, revocation is per source. The account ID in the path lets the Worker pick the Durable Object without a global index; the secret is what authorizes.
- **Dumb pipe:** forward method, query, headers, and raw body byte-exact, so the consumer can verify provider signatures (such as GitHub's HMAC) itself. The relay holds no provider secrets and does no signature checks.
- **Durable queue, at-least-once:** ingress stores the event and answers `202`; on connect the relay sends every pending event oldest first, then live events; an event is deleted only after the consumer's `ack`. The consumer dedupes by event ID.
- **Retention:** unacknowledged events expire after 7 days.
- **Multi-tenant for friends:** the operator creates accounts with an admin token; each account has one bearer token; sources belong to an account.
- **Secrets:** 32 random bytes, base64url. Store only SHA-256 hashes of account tokens and source secrets; compare hashes.
- **Consumer transport:** WebSocket from the consumer to the relay, authenticated with `Authorization: Bearer <accountToken>` (Bun's `WebSocket` accepts a `headers` option).
- **Protocol versioning:** the relay's first message carries `protocol: 1`; the protocol types are published as `@doorstep/protocol` so Crumble imports them instead of copying.
- **Limits:** request body at most 1 MiB (else `413`): Durable Object SQLite rows were limited to 2 MB in the beta docs, and base64 in the WebSocket message adds a third. At most 10,000 pending events per account (else `507`).

## Constraints

- Bun 1.4.4. Dependencies pinned exactly: `hono@4.13.14`, `zod@4.6.7`, `wrangler@4.156.0`, `@cloudflare/workers-types@5.20261030.1`, `@cloudflare/vitest-pool-workers@0.23.0`, `vitest@5.0.5`, `oxlint@1.90.0` (versions checked with `npm view` on 2026-10-31).
- No `any`; no comments beyond a one-line why, at most 3 lines.
- Check command: `bun run check` = `oxlint --deny-warnings && tsc --noEmit && bun test && vitest run --config vitest.workers.config.ts`.
- Tests make no network calls beyond localhost.
- License: MIT (`LICENSE` in the repo). Repository: `crumble-project/doorstep`, checked out at `../doorstep` next to Crumble's `bot`.

## Out of scope

- The Crumble side (client, triggers, filters, dedupe, the untrusted-content rule). Separate plan in the Crumble repo.
- Answering provider verification handshakes (Slack `url_verification`, Microsoft Graph `validationToken`, Meta `hub.challenge`). v1 always answers `202`. Follow-up issue.
- Cloudflare Email Workers (inbound email to the relay). Follow-up.
- Payload parsing, filtering, signature verification, a web UI, delivery by HTTP push to the consumer.
- Publishing to npm or deploying anywhere.

## Review focus

1. **Redelivery after a dropped connection:** an event sent but not acked before the socket closed is sent again on the next connection, before newer events.
2. **Two sockets for one account:** both receive live events; an `ack` from either deletes the event. No crash, no double delete error.
3. **Revoked source:** `DELETE` a source, then POST to its address: `404`, and the address never works again; pending events from it stay deliverable.
4. **Byte-exact body:** a body with non-UTF-8 bytes and a trailing newline arrives with the same bytes and the same SHA-256.
5. **Expiry while disconnected:** an event older than 7 days is never delivered.

## Files

- `packages/protocol/src/index.ts`: protocol version, message schemas and types.
- `src/secrets.ts`: secret generation and hashing.
- `src/store.ts`: `AccountStore` interface and `RelayEvent` type.
- `src/store-contract.ts`: shared behavior tests every store implementation runs.
- `src/bun/sqlite-store.ts`: `AccountStore` on `bun:sqlite`.
- `src/app.ts`: Hono app, runtime-independent.
- `src/bun/server.ts`: Bun runtime: HTTP plus WebSocket delivery, expiry timer, binary entry.
- `src/worker/index.ts`: Worker entry, routes to the account's Durable Object.
- `src/worker/account.ts`: `Account` Durable Object: SQL store, hibernating sockets, expiry alarm.
- `wrangler.jsonc`, `vitest.workers.config.ts`, `package.json`, `tsconfig.json`, `README.md`, `.github/workflows/check.yml`.

### Task 1: Repository and protocol package

**Files:** create `package.json` (Bun workspace with `packages/*`), `tsconfig.json`, `packages/protocol/package.json` (`@doorstep/protocol`), `packages/protocol/src/index.ts`, test `packages/protocol/src/index.test.ts`.
**Interfaces:**
- Produces:
  ```ts
  export const PROTOCOL_VERSION = 1;
  // Relay to consumer
  type Hello = { type: "hello"; protocol: 1; accountId: string };
  type EventMessage = {
    type: "event";
    id: string;            // ULID, sortable by receipt
    sourceId: string;
    receivedAt: string;    // ISO 8601
    method: string;
    query: string;         // raw query string without "?"
    headers: [string, string][]; // in received order, names lowercased
    body: string;          // base64 of the raw bytes
  };
  // Consumer to relay
  type Ack = { type: "ack"; id: string };
  export const relayMessage: z.ZodType<Hello | EventMessage>;
  export const consumerMessage: z.ZodType<Ack>;
  ```
- [ ] Write tests `parses an event message` and `rejects an unknown type` (`consumerMessage.safeParse({ type: "nack" }).success === false`).
- [ ] Run `bun test packages/protocol`. Expected: fails, module not found.
- [ ] Implement the schemas with zod discriminated unions.
- [ ] Run `bun test packages/protocol`. Expected: passes.
- [ ] Checkpoint: `chore: scaffold repo and protocol package`.

### Task 2: Secrets and the account store on SQLite

**Files:** create `src/secrets.ts`, `src/store.ts`, `src/store-contract.ts`, `src/bun/sqlite-store.ts`, test `src/bun/sqlite-store.test.ts`.
**Interfaces:**
- Produces:
  ```ts
  // secrets.ts
  export function newSecret(): string;               // 32 random bytes, base64url
  export function hashSecret(secret: string): Promise<string>; // hex SHA-256 via crypto.subtle

  // store.ts
  export type RelayEvent = Omit<EventMessage, "type">;
  export type Source = { id: string; createdAt: string };
  export interface AccountStore {
    init(tokenHash: string): Promise<void>;              // once, at account creation
    verifyToken(tokenHash: string): Promise<boolean>;
    addSource(secretHash: string): Promise<Source>;
    listSources(): Promise<Source[]>;
    removeSource(id: string): Promise<boolean>;
    sourceBySecret(secretHash: string): Promise<Source | undefined>;
    enqueue(event: Omit<RelayEvent, "id" | "receivedAt">, now: Date): Promise<RelayEvent | "full">;
    pending(): Promise<RelayEvent[]>;                    // oldest first
    ack(id: string): Promise<boolean>;
    expire(now: Date): Promise<number>;                  // deletes events older than 7 days
  }
  export const MAX_PENDING = 10_000;
  export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  // store-contract.ts
  export function storeContract(name: string, make: () => Promise<AccountStore>): void;

  // bun/sqlite-store.ts
  export function sqliteStores(path: string): { account(accountId: string): AccountStore; close(): void };
  ```
- [ ] Write `storeContract` tests: `acks delete an event`, `pending is oldest first`, `enqueue past MAX_PENDING returns "full"`, `expire drops events older than RETENTION_MS and keeps newer`, `a removed source is not found by its secret`, `body bytes survive a round trip` (non-UTF-8 bytes, compare SHA-256). Run the contract against `sqliteStores(":memory:")`.
- [ ] Run `bun test src`. Expected: fails, module not found.
- [ ] Implement `sqliteStores`: one database, tables keyed by `account_id`; event IDs are ULIDs.
- [ ] Run `bun test src`. Expected: passes.
- [ ] Checkpoint: `feat: account store on SQLite`.

### Task 3: Runtime-independent Hono app

**Files:** create `src/app.ts`, test `src/app.test.ts`.
**Interfaces:**
- Consumes: `AccountStore`, `newSecret`, `hashSecret` (Task 2).
- Produces:
  ```ts
  export type Runtime = {
    adminTokenHash: string;
    account(accountId: string): AccountStore;
    delivered(accountId: string, event: RelayEvent): void; // push to live sockets, if any
    publicOrigin: string;                                   // for source URLs
  };
  export function createApp(runtime: Runtime): Hono;
  ```
  Routes:
  - `POST /admin/accounts` (Bearer admin token) → `201 { accountId, token }`
  - `POST /v1/sources` (Bearer account token as `<accountId>.<secret>`) → `201 { id, url }`, where `url` is `${publicOrigin}/h/<accountId>/<sourceSecret>`; the secret is shown only here
  - `GET /v1/sources` → `200 Source[]`; `DELETE /v1/sources/:id` → `204` or `404`
  - `ALL /h/:accountId/:secret` → `202`, or `404` for an unknown source, `413` over 1 MiB, `507` when full
  - Missing or wrong bearer → `401`
- [ ] Write tests with `app.request` and an in-memory `sqliteStores(":memory:")`: `admin creates an account`, `wrong admin token is 401`, `source URL accepts a webhook and the event is delivered`, `body over 1 MiB is 413`, `deleted source is 404`, `hop-by-hop headers are dropped and others are kept lowercased`.
- [ ] Run `bun test src/app.test.ts`. Expected: fails, module not found.
- [ ] Implement `createApp`. Drop only hop-by-hop headers (`connection`, `keep-alive`, `transfer-encoding`, `upgrade`, `proxy-*`, `te`, `trailer`).
- [ ] Run `bun test src/app.test.ts`. Expected: passes.
- [ ] Checkpoint: `feat: relay routes`.

### Task 4: Bun runtime and binary

**Files:** create `src/bun/server.ts`, test `src/bun/server.test.ts`; modify `package.json` (scripts `start`, `build:binary` = `bun build --compile src/bun/server.ts --outfile dist/doorstep`).
**Interfaces:**
- Consumes: `createApp`, `Runtime` (Task 3), `sqliteStores` (Task 2), protocol types (Task 1).
- Produces: `export function serve(options: { port: number; dataPath: string; adminToken: string; publicOrigin: string }): { url: URL; stop(): Promise<void> }`. Env for the binary: `DOORSTEP_PORT` (default 8787), `DOORSTEP_DATA` (default `./doorstep.sqlite`), `DOORSTEP_ADMIN_TOKEN` (required), `DOORSTEP_PUBLIC_URL` (required).
- [ ] Write tests on port 0: `a connected consumer gets hello then the event`, `an unacked event is sent again after reconnect, before newer events`, `an acked event is not sent again`, `two sockets both get a live event`, `connect without a valid token is 401`.
- [ ] Run `bun test src/bun/server.test.ts`. Expected: fails, module not found.
- [ ] Implement with `Bun.serve({ fetch, websocket })`: `GET /v1/connect` upgrades after checking the bearer; on open send `hello`, then `pending()`; keep `accountId → Set<ServerWebSocket>` for `delivered`; on `ack` call `store.ack`; run `expire` every hour.
- [ ] Run `bun test`. Expected: passes. Run `bun run build:binary`. Expected: `dist/doorstep` exists and starts with the env above.
- [ ] Checkpoint: `feat: Bun runtime and single binary`.

### Task 5: Cloudflare runtime

**Files:** create `src/worker/index.ts`, `src/worker/account.ts`, `wrangler.jsonc`, `vitest.workers.config.ts`, test `src/worker/account.test.ts`.
**Interfaces:**
- Consumes: `createApp`, `Runtime` (Task 3), `AccountStore`, `storeContract` (Task 2).
- Produces: Worker `fetch` that sends `/admin/*` to a new account's Durable Object and every other route to `env.ACCOUNT.idFromName(accountId)`; `class Account extends DurableObject` implementing `AccountStore` on `ctx.storage.sql`, accepting sockets with `ctx.acceptWebSocket` (hibernation) and handling `webSocketMessage`/`webSocketClose`, with an alarm every hour that runs `expire`. Bindings: `ACCOUNT` (Durable Object, SQLite class migration), secrets `ADMIN_TOKEN`, var `PUBLIC_URL`.
- [ ] Write tests with `@cloudflare/vitest-pool-workers`: run `storeContract` against the Durable Object's store, plus `a connected consumer gets hello then the event` and `an unacked event is sent again after reconnect`.
- [ ] Run `vitest run --config vitest.workers.config.ts`. Expected: fails, module not found.
- [ ] Implement. Store bodies as SQL BLOBs. Confirm the current string/BLOB row limit at https://developers.cloudflare.com/durable-objects/platform/limits/; if it is below 1 MiB plus overhead, stop and report instead of changing the 1 MiB decision.
- [ ] Run `bun run check`. Expected: passes.
- [ ] Checkpoint: `feat: Cloudflare Workers runtime`.

### Task 6: README and CI

**Files:** create `README.md`, `.github/workflows/check.yml`.
- [ ] README: what Doorstep is (the repo description), how it works (address, queue, outbound WebSocket, at-least-once with ack), self-hosting with the binary and env, deploying to Cloudflare (`wrangler deploy`, secrets), the protocol messages from Task 1, limits (1 MiB, 10,000 pending, 7 days), security notes (the relay can read payloads; host your own; source URLs are secrets).
- [ ] CI runs `bun install --frozen-lockfile && bun run check` on push and pull requests; keep it under two minutes.
- [ ] Run `bun run check`. Expected: passes.
- [ ] Checkpoint: `docs: README and CI`.

## Open questions for the owner

1. Name collision check for "Doorstep" on npm and domains before publishing `@doorstep/protocol`.
