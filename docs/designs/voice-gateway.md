# Voice gateway on the server

**Status:** parts 1 to 3 implemented (a first real call worked end to end). Part 4 implemented, not yet tested on a real phone.

Where the build deviated from or settled this design, the text below says so under **As built**.

## Problem

The voice gateway (`crumble-voice`, a separate Go process) carries phone calls between the owner and bot chats. Today the server knows nothing about it:

- It signs in with the owner's email and password and holds a full account session (`crumble-voice/internal/crumble/client.go:51-97`, README "Known limits"). A leaked gateway host leaks the whole account, including admin routes if the owner is an admin.
- A spoken message is an ordinary owner message. The gateway prepends `call.callNote` to the first message of a call to tell the bot its reply is read aloud (`internal/call/call.go:186-188`, `crumble-voice.example.json:53`). The transcript shows the note as typed text and nothing marks the message as spoken.
- Lines, the owner's numbers, and bot IDs live in the gateway's JSON file (`crumble-voice.example.json:17-29`). The owner edits a file on another machine to give a bot a line.
- A bot cannot call the owner. Outbound calls go through the gateway's local control server, `POST /v1/calls` with its own bearer token (`internal/control/server.go:35-61`). Nothing in the server calls it: a search of `apps/server/src` and `apps/web` for `8790`, `/v1/calls`, and `crumble-voice` finds nothing.

The three fixes share one server contract, so this document designs them together: a scoped voice gateway token (part 1), spoken messages (part 2), and voice configuration on the server, including bot-placed calls (part 3).

## Summary

- **Own feature folder** `apps/server/src/voice-gateway/`, not a message gateway adapter.
- **Gateway-facing routes under `/v1/voice/`**, reachable only with a voice gateway token. Owner routes under `/v1/voice-gateway`, reachable only with a session.
- **Voice gateway token** `<accountId>.<secret>`, the viewer ticket's format, hashed like an invite, one per account, stored in the account's `settings` table. The host routes it to the account by its prefix; the account checks the hash. "Gateway" alone means message gateway in this codebase, so every name here says voice.
- **Spoken messages** use the existing `origin.via` field with the value `voice`. No schema change. The server frames each spoken message for the model.
- **Configuration** (lines, owner numbers) is stored on the server and pushed to the gateway as the first event of one long-lived SSE stream. SIP and speech secrets stay local.
- **Outbound calls** come from a `call_owner` bot tool, offered only while a gateway that declared it can place calls is connected. The server sends the call request down that same stream, so the gateway can sit behind NAT. The gateway's control server goes away.
- **No new tables, no migration.**

Simpler than the brief in four places: no `spoken` field (the contract already has `via`), no separate config-fetch route (the stream's first event is the config), no token table (one settings row), and no server-to-gateway channel (the gateway's own stream carries calls).

## Part 1: Voice gateway token

### How auth works today

- The host authenticates every tenant request with Better Auth (`app/server.ts:250-252`), then forwards it to the account's Hono app with the account's internal bearer token (`app/server.ts:230-241`). The account app accepts only that token on `/v1/*` (`app/api.ts:180`). Every route sees a fully authorized owner; there are no scopes.
- **Viewer tickets** are the one credential that is not a session. A ticket is `<accountId>.<random>` (`bot-desktop/desktop-viewer.ts:77-78`). The host reads the account from the ticket's prefix without a lookup (`desktop-viewer.ts:48-55`) and forwards it to that account only when no session is present (`app/server.ts:254-259`). The account checks the ticket itself. Tickets live in memory for a minute.
- **Invites** store only `sha256(token)` (`app/invites.ts:26-27`), return the token once at creation (`invites.ts:48-58`), and revoke by marking the row (`invites.ts:72-82`). They live in `auth.sqlite`, which the host owns.
- **Doorstep** goes the other way: Crumble holds a token for the relay and sends it outward (`event-sources/doorstep-client.ts:18`, `event-sources/event-relay.ts:31`). It is not a pattern for a credential the server issues.
- Message gateway settings are a JSON row in the account's `settings` table, key `message-gateway:<id>` (`message-gateway/message-gateway.ts:225`, `shared/settings-repository.ts`).

### Decision

Combine the viewer ticket's routing with the invite's storage.

- **Format:** `<accountId>.<secret>`, where `secret` is `randomBytes(32).toString("base64url")`, the same as a viewer ticket. `ACCOUNT_ID_PATTERN` (`shared/account-id.ts`) excludes `.`, so the existing `ticketOwner` regex (`desktop-viewer.ts:48-52`) parses it. Move `ticketOwner` to `shared/account-id.ts` as `credentialAccount` so both features import it from `shared/`.
- **Storage:** one row in the account's `settings` table, key `voice-gateway:token`, value `{ "hash": "<sha256 hex of the whole token>", "issuedAt": "<ISO time>" }`. The token itself is never stored or logged. A hash of a 256-bit random value needs no encryption, so it does not go through `Secrets` or the encrypted-table list. `VoiceGateway` also keeps the current hash in memory, read at layer start and replaced on every issue or revoke, so stream registration can check it without a database read.
- **Issuance:** the owner issues a token in settings. Issuing replaces the stored hash, so the previous token stops working at once. The response carries the token once; it cannot be shown again.
- **Revocation:** delete the row and clear the in-memory hash. The service closes every open `/v1/voice/*` stream (the gateway's event stream and its chat event streams), so a revoked gateway loses its live connections immediately, not at its next request. A request that passed the token check before the revoke but registers its stream after the sweep is caught at registration: see "Stream registration" below.
- **Lifetime:** no expiry. It is a service credential the owner rotates, like the Doorstep token.
- **One per account.** One account runs one voice gateway (see Open decisions).

### How a request is authorized

Host (`app/server.ts`, `requestHandler`):

1. Delete any incoming `x-crumble-voice-gateway-token` header from every request, before anything else reads it.
2. If the path starts with `/v1/voice/`:
   1. If `state.closed`, answer `503` as `accountResponse` does (`app/server.ts:258`, `264`), before `pool.tenant()` could create a tenant during shutdown.
   2. Read `Authorization: Bearer <token>`. Take the account from the token's prefix; if there is none, or `hasUser` is false, answer `401 { "error": "Voice gateway token required" }`. The account answers a wrong secret with the same status and body, so responses don't reveal which account IDs exist.
   3. Never call `getSession` on this path, so a session cookie or session bearer does not reach these routes.
   4. Copy the token into `x-crumble-voice-gateway-token` and forward to that account with `forward()`, which sets the internal bearer as today. Set `Cache-Control: no-store` on the response, as `accountResponse` does (`app/server.ts:267`).
3. Every other path is unchanged. A voice gateway token sent to any other route gets no session and `401` (`app/server.ts:261-262`). Better Auth 1.7.14's `bearer()` plugin treats a bearer containing `.` as a signed session token and returns without a session when the HMAC check fails (`node_modules/better-auth/dist/plugins/bearer/index.mjs:34-42`). Step 3 keeps a test for it.

Account (`voice-gateway/voice-gateway-api.ts`):

- `app.use("/v1/voice/*", ...)` registered before the feature's routes. It hashes the header's token and compares the digest with the in-memory hash using `timingSafeEqual`. Missing header, no token issued, or mismatch: `401 { "error": "Voice gateway token required" }`.
- The token reaches only the routes under `/v1/voice/`. That prefix is the whole scope: there is no per-route permission list to keep in sync.

### Stream registration

A check at request time is not enough for a stream: a revoke or a line change can land between the check and the moment the stream registers. `VoiceGateway` keeps, in memory, the token hash and a generation per line, a counter it raises whenever the line's bot changes, the line is removed, or its bot is deleted or disabled. This is the message gateway's pattern of checking `connections.live(id, generation)` before acting (`message-gateway/gateway-delivery.ts:70`).

- The middleware passes the hash it matched and, on line routes, the line's generation at that moment.
- A stream registers through `VoiceGateway`, which compares both with the current values under the same lock that sweeps streams. A mismatch closes the stream at once.
- Every change sweeps: a token change closes every `/v1/voice/*` stream; a line's generation change closes that line's event streams. Changes to other lines or to the owner's numbers close nothing; they send a new `config`.

`untrustedOrigin` and `needsOriginForWrite` (`app/server.ts:63-80`) pass, as the gateway sends neither `Origin` nor cookies.

### What the token can do

Exactly the routes in "Gateway-facing routes" (part 3): read the configuration (lines with their bot IDs and names, the owner's numbers), submit spoken messages to bots that have a line, read those bots' chat event streams and their voice executions, and report call outcomes. It cannot list or change bots, read other bots, place calls by itself, reach settings, or touch admin routes.

### Rejected options

- **Better Auth API keys or a second session for a "gateway user".** Every session is a full owner session (`app/api.ts:180`); scoping it means a permission check in every route. Rejected.
- **Let the token reach the existing routes** (`/v1/agents/{id}/messages`, `/v1/agents/{id}/events`, `/v1/executions`) and have the host filter by path and bot. The host would need to know which bots have lines (account data), and the message route takes a client UUID as `requestId` (`contract/api-contract.ts:100-105`), so the server could not mark the message as spoken without trusting the client. Rejected for dedicated routes under one prefix.
- **A table `voice_gateway_tokens`** with labels, `last_used_at`, and several live tokens. Only needed for several gateways per account. Rejected until then; the settings row upgrades to a table without changing the token format.
- **Store the hash in `auth.sqlite` so the host verifies it.** The host would gain account data, and revocation would need the host to close account streams. The account already verifies viewer tickets itself. Rejected.
- **Storing the token encrypted so the UI can show it again.** A recoverable secret is a worse secret; issuing a new one is one click. Rejected.

### Security considerations

- A leaked token gives owner authority in every lined bot's chat: a spoken message is an owner message, as a Discord message is (`docs/plans/2026-10-31-message-gateway.md:15`). That is inherent to a voice gateway. The scope removes everything else the password gave: other bots, settings, credentials, logins, account deletion, admin.
- A leaked token reads lined bots' chat snapshots, which include tool activity. The Go client needs snapshots for streaming partial replies (`internal/crumble/turn.go:104-135`). A narrower stream that carries only the reply to one request is possible later.
- A leaked token reveals the owner's numbers, which the gateway needs to tell the owner from strangers.
- The account ID in the token is not secret; viewer tickets already put it in URLs.
- Caller IDs can be forged by anyone who can send traffic from the registrar's address (crumble-voice README "Known limits"). The server cannot check them. A forged caller ID gets owner authority in a lined bot's chat. This design does not change that; see Open decisions.
- Plain HTTP stays allowed only to loopback or private addresses (`internal/config/config.go:431-455`).

### Go client changes

- `internal/config/config.go`: `crumble` becomes `{ "baseUrl", "tokenEnv" }`; remove `email` and `passwordEnv` (`config.go:37-42`, `137-141`, `417-429`). Require the token to match `^[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{43}$`.
- `internal/crumble/client.go`: remove `SignIn` and the re-sign-in retry (`client.go:51-97`, `298-351`). Send the token as the bearer on every request. A `401` means the token was revoked or replaced: return `ErrUnauthorized` and stop the gateway with a log line that says to issue a new token, instead of retrying.

## Part 2: Spoken messages

### How origin works today

- A message gateway submits with a request ID `gateway:<adapterId>:<uuid>` (`shared/request-ids.ts:24-25`, `message-gateway/message-gateway.ts:160`).
- At admission, `turnSource` parses the request ID and maps `gateway` to `{ kind: "owner", via: adapterId }` (`transcript/origins.ts:74-102`, lines 97-98). `botsAdmission` stores that origin in the entry's metadata (`bots/bots-admission.ts:43-68`, `bots/runtime.ts:179-193`).
- `frameInput` builds the model's text separately from the display text (`bots/input-framing.ts:20-34`); the entry keeps the display text in `data.text` (`bots/runtime.ts:792`, `803-813`). Bot relays already use this to add instructions the transcript doesn't show.
- The contract's `MessageOrigin.via` is an optional string documented as "the gateway's ID, such as `discord`" (`contract/api-responses.ts:156-159`). Reads accept any string (`transcript/entries.ts:28-48`).
- The web transcript prints "Sent from {label}" under an owner message with `via` (`apps/web/features/chat/transcript.tsx:570-575`), with labels from `components/gateway-brand.tsx` (unknown IDs show the ID and a generic icon).
- Clients cannot forge an origin: the message route requires `requestId` to be a UUID (`contract/api-contract.ts:102`).

### Decision

- **Request ID** `voice:<callId>:<uuid>`, built by the server from two UUIDs the gateway sends. Add `voiceRequest(callId, id)` and `{ kind: "voice"; callId: string; id: string }` to `shared/request-ids.ts`, parsed like `gateway`.
- **Origin** `{ kind: "owner", via: "voice" }`. `turnSource` maps `voice` there. `VOICE_VIA = "voice"` lives in `shared/request-ids.ts`, so `bots/` reads it without importing the feature.
- **Model framing.** `frameInput` puts a fixed note ahead of the text when the origin is `owner` with `via` `voice`:

  ```text
  [Spoken on a phone call. Your reply is read aloud: answer briefly in plain sentences, without lists, tables, code, or links. Saying goodbye does not end the call: when the owner says goodbye or asks you to hang up, call hang_up.]
  ```

  The wording is close to the `callNote` in `crumble-voice.example.json:53`; the gateway has no default for it in code. It goes on every spoken message, not only the first one: compaction can drop the first message, and the owner may type in the web UI during a call, and a typed message must not carry it. It costs about 35 tokens per spoken message. The transcript's text stays what the owner said.
- **Transcript and web UI.** Under a spoken message the web UI shows a phone icon and "Spoken on a call" instead of "Sent from voice". `gateway-brand.tsx` gets a `voice` entry; `GatewayIcon` returns a Tabler phone icon for it, since `simple-icons` has no brand for a phone.
- **`call.callNote` is removed** from the gateway.

### Contract change

Only the description of `MessageOrigin.via` changes (`contract/api-responses.ts:156-159`):

> On an owner message sent through a message gateway: the gateway's ID, such as `discord`. On a spoken message from a voice gateway call: `voice`.

No field, enum, or status changes. `bun run openapi:generate` rewrites one description in `openapi/openapi.json`. `openapi/chat-snapshot.schema.json` carries `via` without a description (lines 53-55), so it does not change.

### Native clients

Nothing enforces compatibility (`docs/api-contract.md:3`). What they see:

- **iOS and macOS** render `GatewayOriginLabel` for any `via` (`apple/ios/Crumble/Views/MessageView.swift:110`, `apple/macos/Sources/Crumble/ChatMessages.swift:124`). `gatewayLabel` knows only `discord` and falls back to the ID (`apple/apfelkern/Sources/apfelkern/ChatCards.swift:46-48`); the icon falls back to the `message` symbol (`apple/apfelkern/Sources/BotAvatar/BrandLogo.swift`). They show "Sent from voice". It works; a follow-up issue should map `voice` to a phone symbol and "Spoken on a call".
- **Android** drops `via` when it maps the contract (`android/app/src/main/java/dev/crumble/android/network/ContractAdapters.kt:93`, `109`). Spoken messages show as typed owner messages. Nothing breaks.
- **What clients must tolerate:** an unknown `via` value; request IDs starting with `voice:` (clients treat request IDs as opaque); and new operations under `/v1/voice-gateway` and `/v1/voice/` in regenerated clients, which they never call.

### Rejected options

- **A new `spoken: true` field on messages, or a new origin kind `phone`.** Every spoken message comes through the voice gateway, so `via` already says it. A new kind would also make `requestSource` (`transcript/origins.ts:36-55`) treat the owner's words as not the owner's unless updated, and older clients would lose the owner styling. Rejected.
- **Reuse `gateway:voice:<uuid>`.** No server change at all, but `gateway` means message gateway in code and docs, and the call ID would have nowhere to go. Rejected.
- **Spoken-reply instructions as a prompt section while a call is active.** Needs call state in the bot runtime and still has to tell the bot which message was spoken. Rejected.
- **Keep the note in the gateway, on the server's say.** The note would stay in the transcript. Rejected.

## Part 3: Managing voice from the server

### Adapter or own feature

Voice is its own feature folder, `apps/server/src/voice-gateway/`. The message gateway's adapter interface doesn't fit at any point:

| `ChatAdapter` (`message-gateway/adapter.ts`) | Voice gateway |
| --- | --- |
| `connect(host)` makes the server open an outbound connection to the platform with a token from `Secrets` (`adapter.ts:34-39`). | The gateway is a separate process that connects to the server. The server has nothing to connect to. |
| `GatewayConnection.send` delivers a finished answer in chunks, with nonces and retries for up to 24 hours (`adapter.ts:14-25`, `gateway-delivery.ts:78-112`, plan line 17). | A call needs the reply while it is written (`partial=true`), and has no use for it after hang-up. |
| Durable receipts replay each inbound message once (`message-gateway/schema.ts:10-39`). | A turn is live. The gateway already makes retries idempotent with its request ID. |
| Routing picks a bot by default bot, `@handle`, or reply (`message-gateway/routing.ts`, `contract/message-gateway.ts:10-49`). | The line picks the bot. |
| Authorization is one owner user ID plus channel IDs. | Authorization is a caller ID among the owner's numbers. |

What voice shares with it is reused, not abstracted: the owner origin with `via` (`transcript/origins.ts:97-98`), the request-ID prefix pattern, configuration as a settings row (`message-gateway.ts:225`), `ConnectionStatus` (`shared/domain.ts:131-138`), and the label map in `gateway-brand.tsx`.

Voice is not a plugin either. Plugins contribute vendors and adapters (ADR 0004); voice has no vendor on the server side. Its speech providers stay in the gateway.

### What stays local, and why

| Setting | Where | Why |
| --- | --- | --- |
| Each line's bot, display name, whether the bot may call from it | Server | It is the owner's product decision, made where the bots are. |
| Owner's numbers | Server | They decide who gets owner authority, and the `call_owner` tool needs one to dial. |
| SIP registrar, transport, bind host and port, external host, RTP ports, register expiry | Gateway | They describe the network the gateway runs in. The server cannot check them, and they change when the gateway moves, not when the owner changes bots. |
| SIP account passwords | Gateway, by username | They are credentials for the owner's telephone system, created on that system (for example a router's IP phone accounts). Sending them through the server would put them in a second database and in reach of anyone holding the voice gateway token. |
| Speech provider, API key, models, voices, voice and live instructions | Gateway | The keys are the gateway's own spend. Valid voices depend on the speech mode (`internal/config/config.go:350-394`), which only the gateway knows. |
| Call limits and phrases (`call.*`), stranger recording | Gateway | Tied to the gateway's speech timing and local audio files. See Open decisions on moving phrases. |
| `call.callNote` | Removed | The server frames spoken messages (part 2). |
| Control API (`control.*`) | Removed | Outbound calls come through the server (below). |

A line on the server names a SIP username. The gateway registers a line only if it has a password for that username, and reports the others as missing (step 7 below).

### Storage

One settings row, key `voice-gateway`, holds the configuration, validated with Zod on read and write, as the message gateway does. A stored value that no longer validates reads as the default (disabled), so a bad row cannot open a line. No table, no migration. Only `PUT /v1/voice-gateway` writes the row, so no two writers race on it.

Deleted and disabled bots are filtered on read: the stored line stays, and what the gateway receives leaves it out, so the gateway unregisters it. Enabling the bot brings the line back. The settings page shows a line whose bot was deleted as "Bot deleted" for the owner to remove. A `BotDeletion` hook that rewrote the row was rejected: it and `PUT` would both read, modify, and write one row, and a save that started before the delete could restore the deleted bot's line.

**What re-sends `config`.** No hook tells features that a bot was enabled, disabled, or renamed: a search of `apps/server/src` for change listeners on bots finds none, and `AgentRepository` is not among the repositories with change callbacks (`app/product-layer.ts:71-79`). The message gateway handles this by reconciling on a one-second tick (`message-gateway/message-gateway.ts:174-179`, `shared/ticker.ts`). `VoiceGateway` does the same: while a voice gateway stream is live, each tick computes the served config from the settings row and `AgentRepository.list`, and sends `config` and raises line generations when it differs from the last one sent. The cost is one settings read and one bot list per second per connected account. A save also sends at once, without waiting for the tick.

### Owner routes (session)

Defined in a new `contract/voice-gateway.ts` and `contract/api-contract.ts`, served by `voice-gateway/voice-gateway-api.ts`. Singular, like `/v1/event-relay` (`contract/api-contract.ts:281-298`).

```ts
const ownerNumber = z.string().regex(/^\+?[0-9*#]{1,32}$/u); // same rule as config.go:233
// config.go:234's rule, minus "." and "..": the username is a path segment in /v1/voice/lines/{username}.
const sipUsername = z
  .string()
  .regex(/^[A-Za-z0-9._~+-]{1,64}$/u)
  .refine((name) => name !== "." && name !== "..");

export const voiceGatewayConfigInput = z
  .object({
    enabled: z.boolean(),
    ownerNumbers: z.array(ownerNumber).max(20), // order matters: call_owner dials the first
    lines: z
      .array(
        z.object({
          username: sipUsername,
          botId: z.uuid(),
          displayName: z.string().trim().max(64).nullable(), // null: the bot's name
          callsOwner: z.boolean(),
        }).strict(),
      )
      .max(64),
  })
  .strict();
// Refinements: usernames unique, bot IDs unique (one bot chat runs one turn at a time,
// config.go:609-612), numbers unique, at least one number when enabled.

export const voiceGatewayResponse = z.object({
  config: voiceGatewayConfigInput,
  token: z.object({ issuedAt: z.string() }).nullable(),
  status: z.enum(CONNECTION_STATUSES),
  connectedAt: z.string().nullable(),
  lines: z.array(z.object({
    username: z.string(),
    registered: z.boolean(),
    error: z.string().nullable(),
  })), // the gateway's last report (step 7); empty until it reports
});
```

**As built:** the response also has `unavailableLines: [{ username, reason: "botDeleted" | "botDisabled" }]`, the configured lines the voice gateway does not receive (`contract/voice-gateway.ts:75-85`, `voice-gateway/voice-gateway.ts:39-51`).

| Operation | Route | Request | Response |
| --- | --- | --- | --- |
| `getVoiceGateway` | `GET /v1/voice-gateway` | | `200 voiceGatewayResponse` |
| `updateVoiceGateway` | `PUT /v1/voice-gateway` | `voiceGatewayConfigInput` | `200 voiceGatewayResponse`; `400` for an unknown bot ID, as `message-gateway.ts:214-221` |
| `issueVoiceGatewayToken` | `POST /v1/voice-gateway/token` | | `201 { token: string, issuedAt: string }`; replaces any earlier token |
| `revokeVoiceGatewayToken` | `DELETE /v1/voice-gateway/token` | | `204`; `404` when none is issued |

Saving pushes a new `config` event to the connected gateway.

### Gateway-facing routes (voice gateway token)

All under `/v1/voice/`. `{username}` is a line's SIP username; an unknown one, or one whose bot is deleted or disabled, answers `404`.

**OpenAPI.** `define()` gives every route `BearerAuth` or `SessionCookie` security and a 401 described as a missing session (`contract/route.ts:59-61`, `74-85`). These routes need their own: register a `VoiceGatewayToken` HTTP bearer scheme next to `BearerAuth` (`contract/api-contract.ts:1487-1499`), and add `defineVoiceGateway()` to `contract/route.ts`, the same as `define()` but with `security: [{ VoiceGatewayToken: [] }]` and a 401 described as a missing or revoked voice gateway token. The new SSE payloads join `response.eventSchemas` (`contract/api-responses.ts:1115-1140`) as components with artifacts, like every SSE event (`docs/api-contract.md:12-20`): `voice-gateway-config.schema.json`, `voice-call.schema.json`, `voice-call-cancel.schema.json`, `voice-gateway-replaced.schema.json`.

| Operation | Route | Request | Response |
| --- | --- | --- | --- |
| `streamVoiceGatewayEvents` | `GET /v1/voice/events` | query `{ calls?: stringbool }` | SSE: `config`, `call`, `cancel`, `replaced`, `heartbeat` |
| `sendSpokenMessage` | `POST /v1/voice/lines/{username}/messages` | `{ callId: uuid, requestId: uuid, content: string (1..MAX_MESSAGE_CHARS) }` | `202 Execution` (the existing `executionResponse`) |
| `streamVoiceLineEvents` | `GET /v1/voice/lines/{username}/events` | query `chatEventsInput` (`limit`, `partial`) | SSE: `snapshot`, `heartbeat`, the same `ChatSnapshot` as `/v1/agents/{id}/events` |
| `getSpokenExecution` | `GET /v1/voice/lines/{username}/executions/{executionId}` | | `200 { execution: Execution, reply: string[] \| null }`; `404` unless the execution belongs to the line's bot and its request ID starts with `voice:` |
| `reportVoiceCall` | `POST /v1/voice/calls/{callId}` | `{ outcome: "ringing" \| "answered" \| "unanswered" \| "busy" \| "failed", error?: string (max 500) }` | `204`; `404` for an unknown, settled, or cancelled call, after which the gateway hangs up |
| `reportVoiceLines` | `PUT /v1/voice/lines` | `{ lines: [{ username, registered: boolean, error: string \| null }] }` | `204` |

`sendSpokenMessage` calls `Bots.sendChat(botId, content, voiceRequest(callId, requestId))` (`bots/bots-submissions.ts:107-122`). Retrying with the same IDs and content returns the same execution; different content returns `409` (`bots-submissions.ts:69-72`).

`getSpokenExecution` returns the reply read by submission ID with `BotRuntime.response` (`message-gateway/gateway-delivery.ts:101-106`) once the execution is `done`, and `null` before. The Go client now finds a reply by scanning snapshot messages between its request and the next owner message (`internal/crumble/client.go:225-250`); the message gateway's plan names that kind of read as the bug to avoid ("Read by submission ID, not the latest transcript entry", plan line 38).

`streamVoiceLineEvents` shares its body with `registerChatEventRoutes` (`bots/chat-api.ts:114-135`): factor the handler into one function both routes call.

**As built:**

- `reportVoiceLines` answers `409` unless the caller's token opened the live events stream. The line report lives only in memory and is cleared when that stream closes or is replaced (`voice-gateway.ts:181`, `375`, `394`, `547-557`).
- Every line route re-checks the token under the service's lock, in `VoiceGateway.line`, and answers `401` when it was revoked or replaced after the middleware matched it (`voice-gateway.ts:320-337`, `voice-gateway-api.ts:36-38`).
- The host and the account refuse with one function, `voiceGatewayRefusal`: same status, body, and `Cache-Control` header, though not the same timing (`voice-gateway-api.ts:21-26`, `app/server.ts` `voiceGatewayResponse`).
- A message gateway adapter may not use the ID `voice`, which spoken messages carry as `via`; `MessageGateway.layer` refuses to start with one (`message-gateway/message-gateway.ts`).

SSE events on `/v1/voice/events`:

```ts
// event: config. Sent first on every connection, and after every change.
{
  enabled: boolean,
  ownerNumbers: string[],
  lines: Array<{
    username: string,
    botId: string,
    botName: string,
    displayName: string, // the line's, or the bot's name
    callsOwner: boolean,
  }>, // only enabled bots; empty while voice is disabled
}

// event: call. A bot asks to call the owner. Sent only to a stream opened with calls=true.
{ callId: string /* uuid */, username: string, to: string, greeting: string /* 1..1000 */ }

// event: cancel. The call's turn was aborted or its wait ran out: hang up if it still rings.
{ callId: string }

// event: replaced. Another connection with the same token took over; sent before this stream closes.
{}
```

`calls=true` declares that the gateway can place calls. A gateway from step 6 omits it, so the server never offers `call_owner` while only such a gateway is connected, and never waits on a gateway that would ignore `call` events.

Only one `/v1/voice/events` stream is live per account: a new connection sends `replaced` to the older one and closes it, as message gateway credential replacement closes the old connection (plan line 41). A gateway that receives `replaced` exits with an error saying another gateway uses its token, instead of reconnecting; two gateways sharing a token would otherwise evict each other in a loop. Calls go to the live stream. Its presence is the `status` the owner sees.

### Bot-placed calls

**Tool.** A chat-only extension (`shared/chat-only.ts`) registered through `BotExtensions` from the voice gateway's layer (`bot-ports/bot-extensions.ts`; a new `ExtensionPosition.voice`). It is offered when voice is enabled, the bot is enabled, its line has `callsOwner`, and a stream opened with `calls=true` is live:

```ts
call_owner({ greeting: string /* 1..1000, spoken when the owner answers */ })
```

Extensions are chosen when the turn is configured (`bots/runtime.ts:595-603`, `installExtensions`), so the offer can be stale by the time the model calls the tool. `execute` checks all four conditions again and refuses with the reason if one no longer holds.

- `replay: "unsafe"`, so a crash during a call never dials again on recovery (`@earendil-works/pi-durable` `harness/types.d.ts:243-244`).
- The service mints a `callId`, records a pending call `{ callId, botId, username, to, greeting, acknowledged: false }`, and sends the `call` event to the live stream with the first owner number.
- **Acknowledge.** The gateway reports `ringing` as soon as it starts dialing. A call not acknowledged within 15 seconds fails with "The voice gateway did not take the call." and is cancelled.
- **Reconnects.** Pending calls belong to the account's `VoiceGateway`, not to a stream. When the stream drops and a stream with the same token reconnects, the server re-sends `call` for every pending call not yet acknowledged; the gateway ignores a `callId` it already dials. Reports for acknowledged calls are accepted from the new connection. Pending calls fail only when the token is revoked or replaced, the wait runs out, or the turn ends.
- **Wait.** At most 3 minutes 30 seconds from the `call` event (the gateway rings for at most 3 minutes, `internal/config/config.go:748`).
- **Cancel.** When the turn is aborted (the tool's `context.abortSignal`, as `vision/vision.ts:143` reads it) or the wait runs out, the server drops the pending call and sends `cancel`. The gateway hangs up a call that still rings. If the `cancel` is lost, the gateway's next report for that call gets `404`, and it hangs up then. Either way no call outlives its turn unseen.
- `answered`: the tool returns "The owner answered and heard your greeting. Their reply arrives as a spoken message." and ends the turn with `control: { terminate: true }`, as `react` does (`bots/reaction.ts:28`). The turn must end, because the owner's spoken messages queue in the same bot chat. `unanswered`, `busy`, and `failed` return their reason without ending the turn.
- A server restart drops pending calls with the turn that waits on them. The gateway's next report gets `404` and it hangs up.

**As built:**

- Pending calls are keyed by bot and tool task (`${botId}:${api.taskId}`, `voice-gateway/call-owner.ts:53`). A key is remembered (the last 200, more while pending), so running the same tool call again is refused instead of dialing twice (`voice-gateway.ts:437-462`).
- Any report acknowledges a call, not only `ringing` (`voice-gateway.ts:533`); the acknowledgement limit is 15 seconds (`voice-gateway.ts:24`).
- The Go gateway re-sends `ringing` for each call still ringing after every reconnect, and hangs up when that report gets `404` (`crumble-voice/internal/bridge/bridge.go:177-196`).

**Channel.** The gateway already holds `/v1/voice/events` open, outbound from its side, so a gateway behind NAT or a home router receives call requests with no open port. The `callId` in the event becomes the `callId` of that call's spoken messages, so the transcript ties the call to the tool call that placed it.

### Rejected options

- **Voice as a `ChatAdapter`.** See the table above.
- **The server calls the gateway's control server.** The gateway must be reachable from the server, which fails behind NAT, and its control listener accepts only loopback or private addresses because it has no TLS (`internal/control/server.go`, `config.go:707-719`). It would also need a second shared secret. Rejected.
- **Polling for calls.** Adds up to a poll interval of delay to a ringing phone, and the stream exists anyway for configuration. Rejected.
- **A separate `GET /v1/voice/config`.** The stream's first event carries the same object. Rejected.
- **The server decides per call whether the caller is the owner** (the gateway asks before answering). Keeps numbers away from the token, but a leaked token already grants owner authority, which is worse. It adds a request to every call setup and call state on the server. Rejected.
- **Fire-and-forget `call_owner` with the outcome as a later notice.** The bot would continue its turn while the phone rings, and the owner's first spoken message could arrive before the notice. Rejected.
- **SIP passwords on the server, encrypted.** See the table above.
- **Tables for lines with a foreign key to `agents`.** The cascade would remove a deleted bot's line without a race, at the cost of a migration and a repository for at most 64 rows. Filtering on read gets the same result without either. Rejected while settings rows serve the message gateway.
- **A `BotDeletion` hook that removes the line.** Races with `PUT` on the same row (see Storage). Rejected.
- **Failing pending calls when the stream drops.** The phone may still ring; the gateway's later report would get `404` and the bot might dial again. Rejected for acknowledgement and re-send.

### Security considerations

- `call_owner` dials only numbers in the owner's list, chosen by the server. The bot supplies only the greeting.
- A bot that loops on `call_owner` rings the owner repeatedly. The gateway refuses a second call on a busy line (`internal/sipline/gateway.go:197-199`). See Open decisions on a rate limit.
- `callId` values are UUIDs minted by the server for outbound calls and by the gateway for inbound ones. In parts 1 to 3 the server keeps no inbound call state and the ID only groups messages; part 4 adds call state.
- Removing a line, giving it another bot, or deleting or disabling its bot raises the line's generation, sends a new `config`, and closes that line's open event streams, so a line never keeps reading the old bot's chat. A stream that registers after the change is refused at registration (see Stream registration). Disabling bots is picked up within a tick, about a second.

### Docs, changelog, glossary

- **New page** `apps/docs/content/concepts/voice-gateway.md`, sidebar order 13. Order 11 is `discord.md` and 12 is `event-automations.md`; 13 is free. It covers what the voice gateway does; installing `crumble-voice`; issuing the voice gateway token in **Settings > Voice gateway**; giving a bot a line; the owner's numbers and stranger handling; spoken messages in the transcript; `call_owner`; what stays in the gateway's file; limits (caller ID forgery, one gateway per account).
- `apps/docs/content/reference/api.md`: rows for `/v1/voice-gateway` and `/v1/voice/`, and an exception under "Authenticating" (`api.md:18-19`): `/v1/voice/` takes a voice gateway token, not a session.
- `apps/docs/content/reference/glossary.md`: add **Voice gateway** (missing there) and the terms below.
- `docs/api-contract.md`: the four new artifacts in the artifact table (lines 12-20); `/v1/voice/` streams take a voice gateway token (line 70); `/v1/voice/events` and `/v1/voice/lines/{username}/events` in the SSE table.
- `docs/architecture.md:20`: the host routes voice gateway tokens by their account prefix, like viewer links.
- `CHANGELOG.md` under `## Unreleased`, one line per shipped step.
- `crumble-voice/README.md`: new run instructions; a migration note that existing lines and owner numbers must be re-entered in **Settings > Voice gateway**, since the gateway no longer reads them from its file and an old file fails to start; "Known limits" loses the password and `callNote` lines and gains "one gateway per token".

Proposed `GLOSSARY.md` additions:

> **Line**:
> An account on the owner's telephone system that one bot answers and calls from. A call to it reaches that bot's chat.
> _Avoid_: Extension, phone number, SIP account (in product language)
>
> **Spoken message**:
> An owner message the voice gateway heard on a call. The transcript marks it as spoken, and the bot's answer is read aloud.
> _Avoid_: Voice message, voice note
>
> **Voice gateway token**:
> The credential a voice gateway connects with. It reaches only the account's lines, their bots' chats, and call requests; the owner issues and revokes it in settings.
> _Avoid_: API key, password, session

## Affected code

### `bot`

| File | Change | Step |
| --- | --- | --- |
| `apps/server/src/shared/request-ids.ts` | `voiceRequest`, `voice` parse kind, `VOICE_VIA` | 1 |
| `apps/server/src/transcript/origins.ts` | `turnSource` maps `voice` to `{ kind: "owner", via: "voice" }` | 1 |
| `apps/server/src/bots/input-framing.ts` | Spoken note for `via` `voice` | 1 |
| `apps/server/src/contract/api-responses.ts` | `MessageOrigin.via` description | 1 |
| `apps/web/components/gateway-brand.tsx`, `apps/web/features/chat/transcript.tsx` | "Spoken on a call" with a phone icon | 1 |
| `apps/server/src/voice-gateway/voice-gateway.ts` (new) | `VoiceGateway` service: config with read filtering, token with in-memory hash, line generations, stream registry and sweeps, config tick, pending calls | 2, 3, 5 |
| `apps/server/src/voice-gateway/voice-gateway-api.ts` (new) | Owner routes; token middleware and gateway-facing routes | 2, 3, 5 |
| `apps/server/src/voice-gateway/call-owner.ts` (new) | `call_owner` extension | 5 |
| `apps/server/src/contract/voice-gateway.ts` (new), `contract/api-contract.ts`, `contract/tools.ts` | Schemas, routes, the `VoiceGatewayToken` security scheme, `CALL_OWNER_TOOL_NAME` | 2, 3, 5 |
| `apps/server/src/contract/route.ts` | `defineVoiceGateway()` | 3 |
| `apps/server/src/contract/api-responses.ts` | `via` description (step 1); voice SSE events in `eventSchemas` (steps 3, 5) | 1, 3, 5 |
| `apps/server/src/bot-ports/bot-extensions.ts` | `ExtensionPosition.voice` | 5 |
| `apps/server/src/shared/account-id.ts`, `bot-desktop/desktop-viewer.ts` | Move `ticketOwner` to `credentialAccount` | 3 |
| `apps/server/src/app/server.ts` | Strip the header; `503` while closing; route `/v1/voice/` by token prefix | 3 |
| `apps/server/src/app/api.ts` | `VoiceGateway` in `ApiServices`, its lookup in `apiContext`, `registerVoiceGatewayRoutes` in `featureRoutes` (ADR 0008) | 2 |
| `apps/server/test/support/api.ts` | `testAPI` supplies `VoiceGateway` (ADR 0008: a fixture supplies what its routes reach) | 2 |
| `apps/server/src/app/tenant.ts` | `VoiceGateway.layer` in `leaves` and `start` in `resumeAccount` (step 2); the tool layer (step 5). Shared with every feature: merge in order | 2, 5 |
| `apps/server/src/bots/chat-api.ts` | Factor the chat event stream handler | 3 |
| `apps/web/features/voice-gateway/` (new), `features/settings/sections.ts`, `app/router.tsx` | Settings page | 4 |
| `openapi/` | Regenerated | 1, 2, 3, 5 |
| Docs, glossary, changelog | As listed above | each |

### `crumble-voice`

| File | Change | Step |
| --- | --- | --- |
| `internal/config/config.go`, `config_test.go`, `crumble-voice.example.json` | `crumble.tokenEnv`; `sip.accounts: [{ username, passwordEnv, voice? }]` replaces `lines`; remove `owner`, `call.callNote`; remove `control` in step 7 | 6, 7 |
| `internal/crumble/client.go`, `client_internal_test.go` | Token bearer, no sign-in; `/v1/voice/` routes; `Session` reads `/v1/voice/events` with `readEvents` (`events.go`), without `calls=true`; exits on `replaced` | 6 |
| `internal/crumble/turn.go` | `Turn(ctx, username, callID, content, observer)`; settle with `getSpokenExecution` and its `reply` | 6 |
| `internal/call/call.go`, `call_test.go` | `Bot.Turn` signature; `Options.CallID` replaces `CallNote`; a UUID per inbound call | 6 |
| `internal/sipline/gateway.go`, `gateway_test.go` | Lines and owner numbers from the server's `config`; rebuild registrations on change while no call runs | 6 |
| `cmd/crumble-voice/main.go` | Drop `checkBots` (`main.go:168-187`); run the session loop | 6 |
| `internal/sipline/gateway.go`, `cmd/crumble-voice/main.go` | Open the stream with `calls=true`; dial on `call` events, ignoring known call IDs; report `ringing` and outcomes; hang up on `cancel` or a `404` report; report line registration | 7 |
| `internal/control/` | Delete | 7 |
| `README.md` | Run instructions, known limits | 6, 7 |

**As built (the diago question is settled):** diago registers each line in its own transaction, so the gateway adds and drops registrations on the running SIP stack when a new config applies, once no call is active (`internal/sipline/gateway.go:180-189`, `371-415`). A line whose credentials the registrar refuses (401, 407, 403) retries only every 10 minutes while the other lines keep running (`gateway.go:35`, `563-571`). Shutdown waits at most 2 seconds for calls to hang up (`callsEndTimeout`, `gateway.go:33`, `323-343`).

## Testing

- **Step 1:** `request-ids.test.ts` round-trips `voice:` IDs, including a call ID check. An `input-framing` test shows the note on a spoken message, not on a typed owner message or a Discord one. An admission test shows the entry's `origin.via` is `voice` and `data.text` holds the owner's words without the note.
- **Step 2:** API tests through `testAPI` (`test/support/api.ts`): validation, including `.` and `..` usernames; unknown bot `400`; the token returned once and stored as a hash; issue replacing the hash; revoke `404` when none; a deleted bot's line kept in the row but reported as deleted.
- **Step 3:** host tests in `app/server.test.ts`: a voice gateway token reaches `/v1/voice/events` and gets `401` on `/v1/agents` (the Better Auth bearer case); a session gets `401` on `/v1/voice/events`; an incoming `x-crumble-voice-gateway-token` header is ignored; an unknown account and a wrong secret get the same `401` body; a closing server answers `503` and creates no tenant; responses carry `Cache-Control: no-store`. API tests: a spoken message lands with `via` `voice`; a reused request ID with other content gets `409`; `getSpokenExecution` refuses a non-voice execution; revoking closes open streams; a stream that passed the token check before a revoke is closed when it registers; reassigning a line closes its stream and leaves other lines' streams open; disabling or renaming a bot sends a new `config` within a tick and drops a disabled bot's line; a deleted or disabled bot's line answers `404`; a second events connection sends `replaced` to the first. An OpenAPI test checks that `/v1/voice/` routes list only `VoiceGatewayToken` security.
- **Step 5:** with a fake stream: no tool offered without `calls=true`; `execute` refuses after `callsOwner` is turned off mid-turn; `answered` ends the turn; no `ringing` within 15 seconds fails and cancels; a reconnect with the same token re-sends an unacknowledged call and accepts the final report; aborting the turn sends `cancel` and the late report gets `404`; a missing report times out and cancels; revoking fails pending calls. Use Effect's `TestClock` for the timeouts so the job stays inside the two-minute limit.
- **Steps 6 and 7:** Go tests with `httptest` servers, as `client_internal_test.go` does today: exit on `401` and on `replaced`; `ringing` reported before the answer; hang up on `cancel` and on a `404` report; a duplicate `call` event dials once. No network or keys.

No test needs a phone, a SIP registrar, or a speech provider, and none runs in CI beyond the existing unit jobs.

## Out of scope

- Several voice gateways per account.
- Inbound calls from anyone but the owner reaching a bot.
- Marking a bot's reply as spoken in the transcript.
- Moving speech settings or phrases to the server.
- A call log or call history view.
- Group chats on a line.

## Open decisions

1. **One voice gateway token per account.** Recommend one, replaced on issue: one settings row, no labels. A second gateway started with the same token gets `replaced` and exits. Trade-off: two gateways (for example two houses) need a table and a token list, and `config` would have to say which gateway serves which line.
2. **Remove the gateway's control server** (`POST /v1/calls`) once `call_owner` ships. Recommend removing it: one way to place a call, with the owner's numbers checked on the server. Trade-off: no local `curl` to test a call; a test call becomes a chat message asking the bot to call.
3. **`callsOwner` per line, default off.** Recommend a per-line switch, off for new lines. Trade-off: one more control in the UI, against a bot that starts calling the owner after getting a line for inbound calls.
4. **Rate limit for `call_owner`.** Recommend none at first, with the tool's description limiting it to calls the owner asked for or urgent news, and revisit with real use. Trade-off: a misbehaving bot could ring the owner every few minutes until the owner turns `callsOwner` off.
5. **Which number `call_owner` dials.** Recommend the first number in the list; the owner orders them. Trade-off: no "try the next number" fallback, and the bot can't choose a number by situation.
6. **Phrases and greeting on the server.** Recommend keeping `call.*` phrases local for now. Trade-off: they are owner-facing copy in one language set on another machine; moving them later is one more field in `config`.
7. **Caller ID forgery.** Recommend documenting the limit and leaving it. A per-call PIN would close it but costs every call a spoken code. Trade-off: anyone who can inject SIP traffic at the registrar gets owner authority in lined bots' chats.
8. **Token prefix for secret scanners.** Recommend keeping the viewer ticket's format. Trade-off: a leaked token in a public repository is not recognized by GitHub's scanning; a prefix such as `crumble_gw_` would need its own parser instead of reusing `ticketOwner`.

## Implementation order

Each step ships on its own, passes `bun run check` (or `make check` in `crumble-voice`), and leaves the current gateway working until step 6.

1. **Spoken messages core** (server and web). `voice:` request IDs, `via` `voice`, framing, the web label, the contract description. Nothing produces voice requests yet, so behavior is unchanged; unit tests cover it.
2. **Voice gateway configuration and token** (server). The `VoiceGateway` service with config (filtered on read) and token (hash in the row and in memory), owner routes, `ApiServices`, `apiContext`, `testAPI`, and tenant wiring.
3. **Voice gateway access** (server). Host routing with the `503` check, the token middleware, `defineVoiceGateway()` and the security scheme, `/v1/voice/events` with `config` and `replaced`, spoken messages, line events, spoken executions, line generations, registration checks, sweeps, and the config tick. Needs 1 and 2.
4. **Settings page** (web). **Settings > Voice gateway**: enable switch, owner numbers, lines (bot, SIP username, display name, calls owner), "Bot deleted" lines, connection status, issue and revoke with the token shown once. Needs 2's contract.
5. **`call_owner`** (server). The `calls=true` declaration, the tool with its re-checks, `call` and `cancel` events, `ringing` acknowledgement, pending calls that survive reconnects, `reportVoiceCall`, `reportVoiceLines`. Needs 3. Safe against a step-6 gateway: that gateway never declares `calls=true`, so the tool is never offered to it.
6. **Gateway uses the server** (Go). Token auth, config from the stream, exit on `replaced`, `/v1/voice/` routes, no `callNote`, no `owner` or `lines` in the file. Needs 3 deployed. Old configs fail to start with an unknown-field error (`config.go:296`); the README says to re-enter lines and numbers on the server.
7. **Calls from the server** (Go). Open the stream with `calls=true`, dial on `call` events, report `ringing` and outcomes, hang up on `cancel` or a `404` report, report line registration, delete `internal/control/`. Needs 5 and 6.

Docs and changelog lines go with each step, per `CONTRIBUTING.md:104`. The docs page lands with step 4, when there is something to configure.

**Parallel work:**

- 1 and 2 touch different source files and can be built at the same time.
- 3 and 4 can run in parallel: 3 is server only, 4 is web only.
- 5 and 6 can run in parallel: 5 is server, 6 is Go.
- 1 and 2 share no source file: 2 adds `contract/voice-gateway.ts` and routes in `api-contract.ts`, while `api-responses.ts` changes only in 1, 3, and 5.
- Shared files force an order at merge time, not during development: `openapi/` (regenerate after rebasing; steps 1, 2, 3, 5), `CHANGELOG.md` (every step), `contract/api-contract.ts` (2, 3, 5), `contract/api-responses.ts` (1, 3, 5), `app/tenant.ts` (2, 5) and `app/api.ts` (2), which every other feature touches too, and `voice-gateway/voice-gateway.ts` and `voice-gateway-api.ts` (2, 3, 5, which are sequential anyway).

## Part 4: Call state

**Status:** implemented.

### Problem

The first real call showed three gaps:

1. **The bot cannot see a call end.** The owner said "I will hang up, then call me", hung up, and nothing happened until they typed "i hung up" in the web UI. Nothing reports a call's start or end: the Go gateway's one call path, `converse` (`internal/sipline/gateway.go:788-845`), logs "call ended" and returns, and the server keeps no call state (`voice-gateway/voice-gateway.ts:175-181` holds config, streams, and pending calls only).
2. **A bot-placed call's greeting is invisible.** "Hi! This is Crumble calling you back, as promised. Can you hear me?" exists only as the `call_owner` argument (`voice-gateway/call-owner.ts:40-47`). The web UI and the native clients show no card for that tool result.
3. **`call_owner` during a call fails late.** `callTarget` (`voice-gateway.ts:399-426`) does not know the bot is on a call, so the gateway dials, its `claimLine` refuses with `ErrBusy` ("the bot is already on a call or the gateway is at its call limit", `gateway.go:45-46`, `654-670`), and the owner has already heard a holding phrase.

Owner decisions: the gateway reports call start and end, the server keeps the state, the bot chat shows "call started" and "call ended", a call's end wakes the bot so a promised call back happens, and the bot still dials the first owner number.

### Summary

- **Start:** the gateway reports every call with `PUT /v1/voice/lines/{username}/calls/{callId}` before it speaks the greeting. For a bot-placed call that PUT also counts as `answered`.
- **End:** `POST /v1/voice/calls/{callId}` gains the outcome `ended` with a reason. When no report comes, the server ends the call itself: 60 seconds without a live events stream, 15 seconds after a reconnect without the call being confirmed, a token change, a line change, or 4 hours 5 minutes after the start.
- **State:** one active call per line, in memory and in a settings row `voice-gateway:calls`, so a restart neither forgets a call nor ends one twice.
- **"Call started"** is a data-only transcript entry. The model never sees it; the spoken note on every spoken message already tells it the call is on. For a bot-placed call the entry carries the greeting, so the transcript shows what the bot said.
- **"Call ended"** is a notice, the mechanism credential and script automation notices use: a message from origin `call` that starts a bot turn. When nothing wakes the bot (the bot is disabled, the token was revoked, or an inbound call had no spoken message), it is a data-only entry like "call started".
- **Quiet wake-up:** the notice tells the bot to react with 👍 and write nothing unless something is pending. `react` already ends a turn without a reply notification (`bots/bots-announcements.ts:68-70`). A wake-up turn that writes no text announces nothing either.
- **`call_owner`** is refused, and not offered, while the bot's line has an active call or a call to the owner is ringing.

### How the transcript carries non-messages today

| Mechanism | Stored as | The model sees it | Rendered as | Examples |
| --- | --- | --- | --- | --- |
| **Notice** | A `crumble.message` input, admitted as an execution through `Bots.notice` (`bot-ports/bot-notices.ts`, `bots/bots.ts:171-173`). The request ID decides the origin (`transcript/origins.ts:74-102`). | Yes; it starts a turn | `role: "user"` with a non-owner `origin`. Web: a centered disclosure titled by `originLabel` (`apps/web/features/chat/transcript.tsx:188-199`, `303-346`). | Credential and login notices, script automation results (`automations/script-runs.ts:209-215`) |
| **Job failure** | A `crumble.message` input with `data.jobFailed` (`jobs/jobs.ts:750-768`) | Yes | Normalized to `role: "event"`, `kind: "job-failure"` (`transcript/transcript.ts:523-524`, `559-579`) | A job that ended without an answer |
| **Data-only entry** | A `write` of only `kind` and `data` (`bots/runtime.ts:823-847`, `recordBotMessage`) | No | `role: "event"` with its own `kind` (`transcript.ts:581-600`) | Bot communication, held actions, job questions |

What keeps a notice from counting as the owner's words is `REQUEST_SOURCES` (`transcript/origins.ts:36-55`): a kind mapped to `undefined` gets no `[message ...]` tag (`messageTag`, line 57-61) and is skipped by `ownerMessageOf` (`jobs/owner-request.ts:32-40`), which feeds a desktop job's intent check. That is the code behind the changelog line "Login notices no longer count as the owner's messages, including for a desktop job's intent check" (`CHANGELOG.md:43`). The `Record` type forces every new origin kind to choose.

pi-durable appends a data-only write at once, even mid-run, and queues an input behind a running turn (`@earendil-works/pi-durable` `harness/types.d.ts:677-683`). So a "call started" entry never waits for a turn, and a "call ended" notice waits for the turn that may still be answering the owner's last spoken message.

### Decision: markers

- **"Call started": data-only entry.** A new entry kind `crumble.voice-call`, data `{ callId, phase: "started", direction: "inbound" | "outbound", greeting?, timestamp }`. `BotRuntime.recordCallEvent` writes it the way `recordBotMessage` does. The transcript normalizes it to `role: "event"`, `kind: "call-started"`, `content`: the greeting for a bot-placed call, "Call started" for an inbound one, and a new `call: { callId, direction }` field.
  - The model needs no start marker. Every spoken message reaches it with the spoken note (`bots/input-framing.ts`, `SPOKEN_NOTE`), a typed message during a call reaches it without one and is answered in text, as it should be, and a bot-placed call is already in its context as the `call_owner` call and its "answered" result.
- **The greeting** goes in that entry. The model already has it as the tool argument, so the transcript gains it and the model's context stays as it was.
- **"Call ended": notice when it wakes the bot, data-only entry otherwise.** Request ID `voice-call:<callId>:ended`; origin `{ kind: "call" }`; `REQUEST_SOURCES.call = undefined`. The display text (`data.text`) is one line, such as "The call ended: you hung up after 4 minutes." `frameInput` adds the wake-up instructions to the model's copy only, as it adds `SPOKEN_NOTE`. Without a wake-up, `recordCallEvent` writes `phase: "ended"`, normalized to `kind: "call-ended"` with the same line as content.
- **Web:** one look for all three. A `callEvent` card in `EVENTS` (`apps/web/features/bot-chat/chat-cards.tsx:23-27`) draws a centered marker with a phone icon: "Call started", or "{bot} called you" followed by the greeting as a quote, or "Call ended" with the reason. `originLabel` gets the `call` kind, and `NoticeRow` draws a `call` notice as the same marker instead of a disclosure.

### Decision: routes and reports

| Operation | Route | Request | Response |
| --- | --- | --- | --- |
| `startVoiceCall` (new) | `PUT /v1/voice/lines/{username}/calls/{callId}` | `{}` | `204`: started, or confirmed when already active. `404`: unknown line. `409`: the call ended, or another call is active on the line. |
| `reportVoiceCall` (changed) | `POST /v1/voice/calls/{callId}` | adds `{ outcome: "ended", reason: "hungUp" \| "maxDuration" \| "failed" \| "stopping", error? }` | `204` for an active, ended, or unknown call (an unknown one leaves a tombstone). The existing outcomes keep their `404` for a call that is neither pending nor active. |
| `sendSpokenMessage` (changed) | `POST /v1/voice/lines/{username}/messages` | unchanged | adds `409` when `callId` has ended. An unknown `callId` is still accepted. |

- **Who sends what.** `converse` handles both directions, so the gateway PUTs there, before the greeting, and so before any spoken message. It reports `ended` after `call.Run` returns: `hungUp` when the media ended or the dialog closed, `maxDuration` for `call.ErrMaxDuration`, `failed` for other errors (`gateway.go:835-844`), and `stopping` on shutdown, as `placer.stopped` reports pending calls today (`internal/bridge/bridge.go:198-225`).
- **Bot-placed calls.** A PUT for a pending call settles it as `answered` (the tool returns and ends its turn) and starts the call with the pending event's greeting. The `answered` report that follows answers `204`, because the call is active. Today the pending call is removed on `answered` (`voice-gateway.ts:525-545`), so that report would otherwise get `404` and the bridge would hang up (`bridge.go:310-320`). Only a PUT starts call state: a gateway without this step reports `answered` and gets the old behavior, with no state and no markers.
- **Idempotency and order.**
  - A second PUT for an active call confirms it and writes no second marker.
  - A PUT for an ended call (tombstoned) answers `409`, and the gateway hangs up.
  - `ended` for an active call ends it once. A duplicate gets `204` and changes nothing. An `ended` that arrives before its PUT tombstones the ID, so the late PUT gets `409` and no call stays active.
  - Tombstones keep the last 200 ended IDs, the bound `placed` uses (`voice-gateway.ts:25`, `437-446`).
- **Reconnects.** After every `config` event, which opens each connection (`internal/crumble/session.go:59-65`), the bridge re-PUTs its active calls and re-sends any `ended` report it could not deliver. `recheck` already re-sends `ringing` this way (`bridge.go:177-196`). `ReportCall` tries 3 times, 500 ms apart (`internal/crumble/client.go:34-35`), so a longer outage needs the re-send.

### Decision: server state and ending without a report

`VoiceGateway` keeps `active: Map<username, { callId, botId, direction, greeting?, startedAt, spoken: boolean, confirmedAt }>` and the tombstones. Every change runs under the existing `changes` lock (`voice-gateway.ts:169-170`) and is written to the settings row `voice-gateway:calls`. Only `VoiceGateway` writes that row, under that lock, so nothing else races it. The config row (`voice-gateway`) stays separate, so the config `PUT` doesn't touch call state. On startup the row is loaded and the lease clock starts with no live stream.

The tick (`voice-gateway.ts:559-563`) also runs while a call is active, and ends calls the gateway can no longer report:

| Cause | Ends | Reason in the marker |
| --- | --- | --- |
| No live events stream for 60 seconds (gateway crash, network, server restart without a reconnect) | every active call | `lost` |
| A new events stream (a reconnect or `replaced`) opened 15 seconds ago and the call wasn't re-PUT since | that call | `lost` |
| Token issued or revoked (`closeAll`, `voice-gateway.ts:200-216`) | every active call | `revoked` |
| The line's generation changed: removed, given another bot, bot disabled or deleted (`reconcile`, `voice-gateway.ts:239-243`) | that line's call | `lineChanged` |
| 4 hours 5 minutes after the start (the gateway caps a call at 4 hours, `internal/config/config.go:736`) | that call | `lost` |

On `lineChanged`, the gateway keeps the call until it ends (`Apply` waits for idle, `gateway.go:180-189`). Its next spoken message or re-PUT gets `409`, and it hangs up.

**At most once.** Ending a call moves it from `active` to the tombstones and saves the row under the lock. Only then does the service write the marker or send the notice, outside the lock. A crash in between loses that marker; it can't produce two. The notice's request ID `voice-call:<callId>:ended` also dedupes in `Bots.send` (`bots/bots-submissions.ts:69-72`).

**`call_owner`.** `callTarget` refuses with "You are on a call with the owner now." while the bot's line has an active call, and with "A call to the owner is already ringing." while a pending call is the bot's. `callRefusal` uses the same check, so the tool is not offered during a call (`call-owner.ts:71-83`), and `execute` still re-checks for a turn configured before the call started.

### Decision: the wake-up turn

- **When.** The call ended, the line's bot is enabled, the reason is not `revoked`, and the call is bot-placed or carried at least one spoken message (`spoken` is set by `sendSpokenMessage`). Otherwise a data-only "call ended" entry is written and no turn runs. An inbound call the owner hung up before saying anything can leave nothing pending.
- **Request ID and origin.** `voice-call:<callId>:ended`, parsed to `{ kind: "voice-call", callId }`; `turnSource` maps it to `{ kind: "call" }`. That is not the owner's origin, and the turn is announced with origin `call`.
- **What the model reads:**

  ```text
  [The phone call on your line ended: {reason text}.]
  This turn is only for what the call left open. If you told the owner you would do something after the call, such as calling them back or a task, do it now. If nothing is pending, react with 👍 and write nothing.
  ```

  Reason texts: "the owner hung up", "it reached its maximum length", "the call failed", "the voice gateway stopped", "the voice gateway lost its connection", "your line was given to another bot or turned off".
- **Ending quietly.** `react` terminates the turn (`bots/reaction.ts:28`), and `announceReply` emits nothing when a turn has a reaction and no reply (`bots-announcements.ts:68-70`). So there is no `reply` activity and no push, since push consumes `reply` activities (`push/push.ts:255-258`). For a model that ends with neither text nor a reaction, `announceReply` also skips an execution of origin `call` whose turn has no reply text; otherwise it would push an empty preview. The reaction lands on the "call ended" notice, the turn's input.
- **The bot is mid-turn at hang-up.** The gateway stops speaking and the turn goes on; its reply lands in the chat. The notice queues behind it in pi's inbox and runs next, so the wake-up turn sees that reply in its context.
- **The bot is disabled.** No turn: `Bots.send` refuses a disabled bot (`bots-submissions.ts:62-63`). A disabled bot's line also leaves the served config, which ends the call as `lineChanged`. A data-only marker is written.
- **The gateway died (`lost`).** The bot is woken and told so. `call_owner` is refused until a gateway that places calls reconnects, so a promised call back turns into a chat message, which the refusal text lets the bot explain.
- **A new call starts before the wake-up turn runs.** The turn runs anyway. `call_owner` is refused because the line is on a call.

### Contract and client impact

- `Message` gains an optional `call: { callId: string, direction: "inbound" | "outbound" }`, set on `call-started` and `call-ended` events.
- `MessageOrigin.kind` documents `call` (`contract/api-responses.ts:150-153` already warns that "Clients may receive other values later").
- `kind` gains `call-started` and `call-ended`.
- New route `startVoiceCall`; `reportVoiceCall` gains `ended`; `sendSpokenMessage` gains a `409`. No new SSE events.

What clients that don't know these values show:

| Client | `call-started` / `call-ended` event | `call` notice |
| --- | --- | --- |
| Web | Updated in the same change | Updated in the same change |
| iOS, macOS | `EventView`, a collapsed disclosure wrongly titled "Earlier messages summarized" with the text inside (`apple/ios/Crumble/Views/MessageView.swift:36-38`, `232-233`) | `noticeTitle` returns nil for an unknown kind (`apfelkern/Sources/apfelkern/ChatCards.swift:33-43`), so it is a sent bubble captioned "You" (`ChatSupport.swift:15-23`) |
| Android | `EventView`, the same wrong title (`ui/ChatScreen.kt:367-373`, `709-714`) | `noticeTitle` returns null (`model/Models.kt:588-602`), so it is an owner bubble |

Nothing breaks. Each shows a short text in a misleading frame. Follow-ups for `apple` and `android`: add `call` to `noticeTitle`, and draw the two event kinds as markers.

### Rejected options

- **A notice for "call started" too.** Every call would cost a model input. A turn while the call starts would delay the owner's first answer. The model gains nothing the spoken note doesn't give.
- **Data-only "call ended" plus a separate wake-up notice.** Two transcript items for one end. Rejected for one item that is a notice exactly when it wakes the bot.
- **Normalize the notice to `role: "event"`, as job failures are.** `latestReply` takes the last `role: "user"` message as the turn's input (`transcript/transcript.ts:174-176`). The reaction and the reply announcement would attach to the owner's previous message instead of the notice.
- **The greeting as a bot message** (an assistant entry). The model would read it twice, and writing an assistant entry outside a turn has no precedent. **Or as a `call_owner` result card.** iOS and macOS show only tool results they know (`ChatCards.swift:54-57`), so the greeting would stay hidden there.
- **A `pass` tool in the bot chat for the quiet ending, as group turns have** (`group-chats/group-turns.ts:22-34`). Extensions are chosen per bot, not per input (`bot-ports/bot-extensions.ts`, `ExtensionSource`), so every turn of a bot with a line would carry a way to answer the owner with silence. `react` exists and is already quiet.
- **Call state in memory only.** A server restart mid-call would forget the call: no end marker and no wake-up, and a restarted server could not refuse `call_owner` during the call.
- **Require an active call for spoken messages.** That would break a gateway that predates this part and could not be shipped server-first. Only ended calls are refused.
- **The line report as the source of which calls run.** A report built just before a call started can arrive after its PUT and end the new call. Telling the two apart needs timing rules that explicit start and end reports don't.

### Affected code

`bot` (one server step):

| File | Change |
| --- | --- |
| `apps/server/src/voice-gateway/voice-gateway.ts` | Active calls, tombstones, the `voice-gateway:calls` row, lease rules in the tick, start and end, `callTarget` refusals, markers and notices |
| `apps/server/src/voice-gateway/voice-gateway-api.ts` | `startVoiceCall`; `ended` in `reportVoiceCall`; `409` for an ended call in `sendSpokenMessage` |
| `apps/server/src/voice-gateway/call-owner.ts` | Refusal texts |
| `apps/server/src/contract/voice-gateway.ts`, `contract/api-contract.ts` | The route, the `ended` outcome with `reason` |
| `apps/server/src/contract/api-responses.ts` | `Message.call`; `origin.kind` and `kind` descriptions |
| `apps/server/src/shared/request-ids.ts` | `voiceCallRequest`, the `voice-call` parse kind |
| `apps/server/src/transcript/origins.ts` | `{ kind: "call" }` in `InputOrigin`, `TurnSource`, and `REQUEST_SOURCES` |
| `apps/server/src/transcript/entries.ts`, `transcript/transcript.ts` | `CALL_ENTRY` and its normalization |
| `apps/server/src/bots/runtime.ts` | `recordCallEvent` |
| `apps/server/src/bots/input-framing.ts` | Wake-up instructions for origin `call` |
| `apps/server/src/bots/bots-announcements.ts` | Skip a `call` turn without reply text |
| `apps/web/features/voice-gateway/call-event.tsx` (new), `features/bot-chat/chat-cards.tsx`, `features/chat/transcript.tsx` | The call marker |
| `openapi/`, `apps/docs/content/concepts/voice-gateway.md` (a "Calls in the chat" section), `apps/docs/content/reference/api.md`, `CHANGELOG.md` | As usual |

`crumble-voice` (one Go step):

| File | Change |
| --- | --- |
| `internal/crumble/calls.go` | `StartCall` (the PUT), `ended` with a reason, `ErrCallEnded` for `409` |
| `internal/crumble/turn.go` | `409` on a spoken message returns `ErrCallEnded` |
| `internal/call/call.go` | `ErrCallEnded` ends the call |
| `internal/sipline/gateway.go` | `Options.Calls` (started, ended) called from `converse`; the end reason from `call.Run`'s error |
| `internal/bridge/bridge.go` | Implements `Calls`: tracks active calls, re-PUTs them and re-sends undelivered `ended` after every `config` |
| `README.md` | Calls show in the bot chat |

**Glossary:** no new term. "Call started" and "call ended" are UI labels, and **Voice gateway** already covers calls. **Changelog:** one line for the server step and one for the Go step in `crumble-voice`'s README.

### Tests

Server, in `voice-gateway.test.ts` style (`testVoiceGateway`, the faux provider, `TestClock`, `historyResponse.parse`):

- A PUT writes one `call-started` event; a second PUT writes none.
- A PUT for a pending call returns `answered` to `call_owner`, the marker carries the greeting, and the later `answered` report gets `204`.
- `ended` posts one `call` notice; a faux turn that calls `react` emits no `reply` activity, and one that writes nothing emits none either; a duplicate `ended` adds nothing.
- `ended` before the PUT makes the PUT answer `409`. A spoken message for an ended call answers `409`; one for an unknown call is accepted.
- `call_owner` is neither offered nor executed during an active call or while one is ringing.
- With `TestClock`: 60 seconds without a stream ends a call as `lost` and wakes the bot; a reconnect without a re-PUT ends it after 15 seconds; a re-PUT keeps it; 4 hours 5 minutes end it.
- Revoking ends calls with a data-only marker and no execution. Reassigning a line ends its call and wakes the old bot. A disabled bot gets a data-only marker. An inbound call without spoken messages gets a data-only marker and no execution.
- A restarted account reloads an active call from the row and ends it once after 60 seconds; a tombstoned call stays ended across the restart.

Unit tests:

- `request-ids.test.ts`: `voice-call:` IDs round-trip.
- `input-framing.test.ts`: the wake-up text goes on a `call` notice only.
- An `owner-request` test: a `call` notice is not an owner message.
- A transcript test: normalizes `crumble.voice-call` entries.
- A web DOM test: the three marker forms.

Go, with `httptest` as in `bridge_test.go` and `client_internal_test.go`:

- `converse` reports the start before the greeting and `ended` with each reason.
- A `409` on the PUT or on a spoken message hangs up.
- After a reconnect, active calls are re-PUT and an undelivered `ended` is re-sent.
- Shutdown reports `stopping` within the 2-second bound.

### Implementation order

1. **Server** (`bot`, the files listed above). Ships alone: nothing starts call state until a gateway PUTs, so an older gateway sees no change except that `answered` on an active call answers `204`, which it never sends.
2. **Go** (`crumble-voice`, the files listed above). Needs 1 deployed. A gateway with this step against an older server gets `404` on the PUT, for an unknown route. It must log that and go on with the call, not hang up, so the two can ship in either order.

The steps touch different repositories and can be built in parallel against the contract in this section.

### Open decisions

1. **Which ends wake the bot.** Recommend: bot-placed calls, and inbound calls with at least one spoken message; not after `revoked`. Trade-off: an inbound call cut off before the owner spoke never wakes the bot, which is right unless the owner relies on "call and hang up" as a signal.
2. **Wake after `lost`.** Recommend waking. Trade-off: a model call each time the gateway drops, against a bot that would otherwise never learn the call ended.
3. **Lease windows: 60 seconds without a stream, 15 seconds to re-confirm, 4 hours 5 minutes overall.** Recommend these. The gateway reconnects within 1 to 30 seconds (`session.go:20-21`). Trade-off: shorter windows end calls that survived a network blip; longer ones keep `call_owner` refused after a crash.
4. **Persist call state.** Recommend the settings row. Trade-off: a row write on every start and end, against losing end markers and refusals over a restart.
5. **Quiet ending through `react`.** Recommend `react`, plus the announcement skip. Trade-off: the 👍 stays visible on the "call ended" marker; a `pass` tool would leave no trace but would be offered on every turn.
6. **Show the inbound greeting.** Recommend not: it is the gateway's fixed `answerGreeting` (`gateway.go:783`), not something the bot said. Trade-off: the transcript shows less than the owner heard.
7. **Native follow-ups.** Recommend filing `apple` and `android` issues for `call` notices and call events with this step. Trade-off: until they land, a "call ended" notice looks like an owner message on those clients.

## Part 5: The bot hangs up

**Status:** implemented.

The bot could say goodbye but not end the call. Now:

- **Tool.** `hang_up`, without parameters, is offered instead of `call_owner` while the bot's line has an active call. It sets `hangUp` on the active call, which is saved with the call state.
- **Reply.** `GET /v1/voice/lines/{username}/executions/{executionId}` returns `hangUp`: whether the line's active call is marked. The bot's reply to the same message is its goodbye; an empty reply with `hangUp` is not a failed turn.
- **Gateway.** After a reply with `hangUp`, the gateway says the reply and hangs up once no audio went out for 3 seconds (`call.go`, `defaultHangUpQuiet`). The three speech modes share no "finished speaking" signal, so the gateway watches the audio it writes instead of adding one to each mode. The trade-off is 3 seconds of silence before the hang-up, and a goodbye whose first audio takes longer than that to arrive is cut off.
- **End.** The gateway reports the end as `hungUp`. The server knows the bot asked and shows "Call ended after …: the bot hung up." The end wakes the bot as any other, so "hang up and call me back" works.
