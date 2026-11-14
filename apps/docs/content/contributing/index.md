---
title: Contributing
description: How the server repository is laid out, which checks to run, and how to release.
sidebar:
  order: 1
---

Crumble is split across repositories in
[`crumble-project`](https://github.com/crumble-project). The server and the web
app live in `bot`. So does the canonical glossary, `GLOSSARY.md`, which the
[glossary](/reference/glossary) page copies. When a word in the docs and a word
in the code disagree, the glossary wins.

The server and web app are licensed under the
[GNU Affero General Public License v3.0](https://github.com/crumble-project/bot/blob/main/LICENSE)
(`AGPL-3.0-only`). Contributions to `bot` are accepted under the same license.

## Repository Layout

`bot` is a Bun workspace:

| Path                           | Contents                                                 |
| ------------------------------ | -------------------------------------------------------- |
| `apps/server/src/`             | Server feature modules, with tests next to the code.     |
| `apps/server/drizzle/`         | SQLite migrations for the product store.                 |
| `apps/server/skills/`          | Default skills that ship with the server.                |
| `apps/server/workspace-image/` | Guest manifest, Dockerfile, and desktop scripts.         |
| `apps/web/`                    | The web app, grouped by feature.                         |
| `apps/docs/`                   | This documentation site, built with Blume.               |
| `apps/site/`                   | The landing page at crumbli.ng.                          |
| `openapi/`                     | The generated OpenAPI contract and event stream schemas. |

Server code uses [Effect](https://effect.website). Read `AGENTS.md`
before changing it. [Architecture](/contributing/architecture) shows how the
pieces fit.

## Running the Checks

From the `bot` root:

```bash
bun run check   # lint, format check, typecheck, contract drift, and unit tests
bun run fix     # format and apply lint fixes
bun run ui:add COMPONENT  # add a shadcn/ui component to apps/web
```

`bun install` sets up the Git hooks in `.githooks/`. The commit and push
hooks require the Bun version in `.bun-version`, which CI also uses. Skip them once with
`--no-verify`:

| Hook           | Runs                                                                                                                                                                                                                                                                                    |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit         | Generates and stages OpenAPI artifacts from staged sources, then runs the steering-file path check, lint, format check, and typecheck on the whole tree, and `fallow audit` on the changes since the last commit.                                                                       |
| Commit message | Rejects a commit subject that isn't a Conventional Commit, such as `feat(web): add bot avatars`. Pull request titles get the same check in CI.                                                                                                                                          |
| Push           | Runs the PR checks against the pushed commit and a freshly fetched `origin/main` (`bun install --frozen-lockfile`, `bun run check`, contract validation and compatibility, `fallow audit`, and `apps/docs` / `apps/site` when changed). Refuses dirty trees or un-checked-out branches. |

Unit test jobs in CI must finish in two minutes or less.

## Changing the Database Schema

Store tables live in each feature's `schema.ts` or `schema.<part>.ts`, which
`apps/server/drizzle.store.config.ts` finds automatically. Push tables live in
`apps/server/src/push/schema.ts`. Edit the schema, then generate the migration
from the `bot` root:

```bash
bun run --cwd apps/server db:generate --name short_description       # store.sqlite
bun run --cwd apps/server db:generate:push --name short_description  # push.sqlite
```

## Changing the API Contract

Route and event schemas in `apps/server/src/contract/` generate everything in
`openapi/`. After changing them, regenerate and commit the files:

```bash
bun run openapi:generate
```

`bun run openapi:check` fails if the generated files are out of date, and
`bun run check` runs it for you.

## Chat attention API

Chat attention belongs to the authenticated account, independently of push
registration or notification permission. A chat reference has a `kind` of
`bot` or `group` and an `id`, such as `{ "kind": "bot", "id": "CHAT_ID" }`.
Bot chats and group chats are separate namespaces.

- Send `PUT /v1/chat-attention/views/{viewId}` with `{ "chat": CHAT }` when a
  view becomes active. Send `{ "chat": null }` when it loses attention.
- Give each tab or native window an independent random view ID. Refresh active
  views every 30 seconds. The server timestamps reports and expires them after
  120 seconds.
- Serialize reports per view and discard obsolete queued refreshes. One view
  must never clear another view.
- Send `POST /v1/chat-attention/seen` with `{ "chat": CHAT, "eventIds": ["EVENT_ID"] }`
  only after displaying the referenced content. Batch 1-100 distinct event IDs;
  retry failed batches only while the same account remains signed in.

Replace `CHAT_ID` with the bot or group chat ID and `CHAT` with that chat
reference. Replace `EVENT_ID` with the reply event ID. Both routes return `204` on success. Unknown or inaccessible chats
and mismatched events return `404`. Seen batches are atomic and idempotent.

History and snapshot messages include `replyReferences`. Each reference has an
`eventId` and a `surface`: `text`, `tool-card` with `toolCallId`, or
`held-action` with `actionId`. The containing message's normalized `id`
identifies the exact surface, not just its transcript entry.

Acknowledge only ready content within the active viewport. For mixed text and
request replies, the request card is the acknowledgement surface. Loading
placeholders, unavailable cards, and collapsed summaries do not count. A
confirmed settled card does count. Receiving a live event or fetching history
is not proof that content was displayed.

Associations and seen state persist in the account's `push.sqlite`, separately
from devices and queued deliveries. Generate push schema migrations through
`db:generate:push`; do not infer historical seen state from old presence rows.
New deliveries wait a fixed three seconds after their first enqueue. Retries
recheck attention without adding another grace period.

### Native adoption follow-ups

Apple and Android adoption remains separate work; native behavior has not been
tested for this change. Device registration remains unchanged. The old
`/v1/push/devices/{installationId}/presence` endpoint is removed.

Native clients must implement:

1. Independent view identities for each foreground chat window or view lifetime.
2. Presence only while the matching chat is foreground-active, with a 30-second
   refresh and a clear on backgrounding, navigation, logout, or account switch.
3. Exact `replyReferences` matching, including loaded credential, login, call,
   and held-action cards or their confirmed settled outcomes.
4. Distinct acknowledgement batches, retry cancellation on account changes,
   and serialized presence reports that cannot follow a clear with stale state.

On macOS, a window losing activity must clear its own view. Verify web-to-native
and native-to-native suppression locally after adoption, including group chats.
No simulator, emulator, or native UI checks run in CI.

## Releasing

`apps/server/package.json` holds the version. A release publishes
`crumble-server`, `crumble-workspace`, and `crumble-workspace-desktop` with the
same version, so a server and its workspace images always match.

1. In one pull request:
   - Set `version` in `apps/server/package.json`.
   - Rename `## Unreleased` in `CHANGELOG.md` to `## X.Y.Z`, and add a new
     empty `## Unreleased` above it.
   - Update the image tags in `apps/docs`.
2. Squash-merge it.
3. Tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The Server image and Workspace images workflows publish `X.Y.Z` and `latest`
for each image. If the server workflow fails right away, check that the tag
matches the version in `apps/server/package.json`. Every push to `main` also
publishes `main` and `sha-…` tags.
