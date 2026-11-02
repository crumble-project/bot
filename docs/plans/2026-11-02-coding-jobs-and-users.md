# Coding jobs and user management implementation plan

> Status: implemented on 2026-11-02, uncommitted. Decisions below reflect what was built.

> Implement one task at a time. Review each deliverable before starting the next. Steps use `- [ ]`.

**Goal:** Coding jobs that ask, learn, start warm and run on admin-sized workspaces, on a server with admins, invites, and signed machine account commits.
**Architecture:** Each account runs in its own tenant runtime (`app/server.ts:152`), so server-wide state lives at the host: Better Auth's `admin` plugin in `auth.sqlite`, plus settings and invite tables added to `auth.sqlite` through a schema-only Better Auth plugin, served by host routes under `/v1/admin/` before tenant forwarding. Tenants read workspace settings through a function the host passes in. Coding jobs get an `ask_owner` tool that ends the job's turn with a question the owner answers from the chat or the job panel. Machine accounts get a server-held SSH key; git in the workspace signs through a helper that the credential proxy answers.
**Source:** https://github.com/crumble-project/bot/issues/100

## Decisions

- Roles come from Better Auth's `admin` plugin: it already has roles, user listing and removal.
- The first account becomes admin; on startup, a server with users and no admin promotes its oldest user: no installer setup.
- Sign-up can be turned off; then people join only through one-time invite links: no handed-over passwords.
- Sign-up works with email and password or with a passkey alone (passkey plugin `registration.requireSession: false`; the user is created in `afterVerification`), with or without an invite.
- No per-user or per-bot quotas: users bring their own model providers.
- Workspace CPU, memory, coding image and question grace period are server-wide and admin-only.
- The coding image is a GHCR image reference entered by the admin; no in-app builds or setup scripts. Empty means the environment's `CRUMBLE_WORKSPACE_IMAGE`. Railway can't boot OCI images (its SDK builds templates from apt packages and shell steps), so the setting applies to Microsandbox only.
- Reissue is automatic: a changed image never swaps a running machine; it switches at its next idle stop (coding jobs hold no lease, so the idle stop is the only "idle" the server knows), keeping `/workspace`. `GET /v1/admin/workspaces/outdated` lists those still waiting.
- A job's question ends the job's turn. It shows in the bot chat as a question card and on the job panel; both answer through one endpoint that sends the answer to the job, with no bot turn in between. A plain chat message still reaches the bot, which can pass it on with `send`.
- A job waiting on a question holds its workspace awake for the grace period; then the normal idle stop applies, and the answer boots the workspace again with its files.
- Learning from coding jobs goes into the bot's learned skills through the existing learning review, triggered when a job's report is delivered; no per-repository store.
- Jobs reuse the bot's clone, fetch, branch from the default branch, and reinstall only when the lockfile changed. Listing clones in the job's prompt was dropped: it would boot the workspace on every prompt render.
- Machine account commits are signed with an Ed25519 SSH key the server holds as a keyed secret; git calls a helper that sends the data to a reserved host the credential proxy answers for that bot. The key never enters the workspace.
- Push and the GitHub API stay on the token through the credential proxy; no SSH transport, no GPG.
- Everything ships in one PR.

## Constraints

- `bun run check` passes (`package.json:34`); CI unit-test jobs stay under two minutes.
- Read `apps/server/node_modules/effect/AGENTS.md` before the first Effect change and follow it.
- Terms follow `GLOSSARY.md`; add **Admin** and **Invite link** there.
- API changes go through `src/contract/api-contract.ts`, regenerate `openapi/` (`bun run openapi:check`) and pass `contract:compatibility`.
- Docs in `apps/docs` change with behavior; run `bun run check` in `apps/docs`.
- Settings UI: one line per row (logo, name, action), editing in `EditorSheet`, never a modal.
- Every owner-entered secret also accepts a 1Password or Bitwarden reference through the Secrets service.
- Native clients (`apple/`, `android/`) and `apple/apfelkern/Contract/openapi.json` are out of scope.
- Tests only for the Review focus items and where a task names one; otherwise end on the verification command.

## Out of scope

- Per-user or per-bot quotas, limits, usage accounting.
- SSH git transport, GPG keys, signing for GitHub App identities (API commits are already verified).
- In-app image builds, setup scripts, private registry credentials.
- Email delivery of invites; the admin copies the link.
- Discord and native client rendering of question cards beyond the bot's text.
- Questions from desktop jobs.

## Review focus

1. A regular user calling `/v1/admin/*` directly gets 403.
2. With sign-up off, `POST /api/auth/sign-up/email` without a valid invite fails; an invite works once and not after revocation.
3. A server restart while a job waits on a question keeps the question card and the answer still resumes the job.
4. Reissue never tears down a workspace with a running job or turn.
5. The signing host signs only for the requesting bot's own machine account, and refuses when the bot has none.

## Files

- `apps/server/src/app/auth.ts`: `admin` plugin, first-admin hook, sign-up gate.
- `apps/server/src/app/server-schema.ts` (new): `server_settings`, `invites` tables.
- `apps/server/drizzle.server.config.ts` (new), `apps/server/drizzle/server/` (generated), `package.json` script `db:generate:server`.
- `apps/server/src/shared/database.ts`: `migrationsFolder` accepts `"server"`.
- `apps/server/src/app/server-settings.ts` (new): read and write server settings and invites.
- `apps/server/src/app/admin-api.ts` (new): host handlers for `/v1/admin/*`.
- `apps/server/src/app/server.ts`: route `/v1/admin/`, pass settings to tenants.
- `apps/server/src/contract/api-contract.ts`, `api-responses.ts`, `openapi/`: admin, invite, question endpoints.
- `apps/server/src/workspaces/microsandbox-workspaces.ts`, `railway-workspaces.ts`, `machine-workspaces.ts`: settings-driven size and image, reissue.
- `apps/server/src/jobs/coding.ts`, `jobs/jobs.ts`: `question` tool, question state, answer, warm-repo instructions.
- `apps/server/src/skills/learning-review.ts`: review job conversations.
- `apps/server/src/github-apps/github-apps.ts`, `github-apps/schema.ts`, `github-apps/ssh-signing.ts` (new): signing key, git config.
- `apps/server/src/credentials/credential-proxy.ts`: reserved signing host.
- `apps/server/workspace-image/` : signing helper script.
- `apps/web/app/connect.tsx`: invite sign-up.
- `apps/web/features/settings/admin-settings.tsx` (new), `settings.tsx`: Users and Server sections.
- `apps/web/features/jobs/jobs.tsx`, `apps/web/features/chat/transcript.tsx`: question card and answer box.
- `GLOSSARY.md`, `apps/docs/content/`, `docs/architecture.md`.

### Task 1: Host database and admins

**Files:** create `src/app/server-schema.ts`, `drizzle.server.config.ts`, `src/app/server-settings.ts`; modify `src/shared/database.ts:9`, `src/app/auth.ts:30-80`, `apps/server/package.json:11-12`.
**Interfaces:**

- Consumes: `migrationsFolder` (`src/shared/database.ts:9`), `sqliteDatabase` (used at `src/shared/product-database.ts:20`), Better Auth `admin` plugin (`node_modules/better-auth/dist/plugins/admin`).
- Produces:
  - `type ServerSettings = { signUpOpen: boolean; workspaceCpus: number; workspaceMemoryMib: number; codingImage: string | null; questionGraceMinutes: number }`, defaults `{ true, 2, 2048, null, 15 }`.
  - `ServerSettingsStore`: `get(): ServerSettings`, `update(patch: Partial<ServerSettings>): ServerSettings`, `subscribe(listener: (settings: ServerSettings) => void): () => void`.
  - `createAuth(dataDir, baseURL, settings: ServerSettingsStore)` returns also `isAdmin(userId: string): boolean`.

- [ ] Add `server_settings` (single row, one column per setting) and `invites` (`id`, `token_hash`, `created_by`, `created_at`, `used_at`, `used_by`, `revoked_at`) to `server-schema.ts`; generate the migration with the new `db:generate:server` script.
- [ ] Open `server.sqlite` in `dataDir` in `startServer` and build the `ServerSettingsStore`.
- [ ] Add `admin()` to the auth plugins; in `databaseHooks.user.create.before`, set `role: "admin"` when the user table is empty.
- [ ] After `runMigrations`, promote the oldest user by `createdAt` when users exist and none has role `admin`.
- [ ] Test (`src/app/auth.test.ts`): first sign-up has role `admin`, second `user`; a database with two users and no admin promotes the older.
- [ ] Run `bun test src/app/auth.test.ts`. Expected: passes.

### Task 2: Admin API, sign-up gate, invites

**Files:** create `src/app/admin-api.ts`; modify `src/app/server.ts:20,246-275`, `src/app/auth.ts`, `src/contract/api-contract.ts`; test `src/app/multi-user.test.ts`.
**Interfaces:**

- Consumes: Task 1 `ServerSettingsStore`, `isAdmin`; `auth.api.getSession` (`src/app/server.ts:203`).
- Produces, all admin-only (403 otherwise):
  - `GET /v1/admin/users`, `PATCH /v1/admin/users/{id}` (`{ role: "admin" | "user" }`), `DELETE /v1/admin/users/{id}` (also removes `dataDir/users/{id}` after closing its tenant).
  - `GET /v1/admin/invites`, `POST /v1/admin/invites` returning `{ id, url }` with `url = {origin}/ui/connect?invite=<token>`, `DELETE /v1/admin/invites/{id}`.
  - `GET /v1/admin/settings`, `PATCH /v1/admin/settings` (`Partial<ServerSettings>`).
  - The web app reads the role from the Better Auth session (`session.user.role`, added by the `admin` plugin); no new endpoint.

- [ ] Route `/v1/admin/` in `server.ts` before `accountResponse`, to `adminResponse(request, identity, settings)`.
- [ ] Gate sign-up with a Better Auth `hooks.before` on `/sign-up/email`: when `signUpOpen` is false, require an `invite` field whose token hash matches an unused, unrevoked invite; mark it used in an `after` hook with the new user's id.
- [ ] An admin can't demote or remove the last admin: 409.
- [ ] Tests: Review focus 1 and 2.
- [ ] Run `bun test src/app/multi-user.test.ts`, `bun run openapi:check`. Expected: pass.

### Task 3: Users and server settings in the web app

**Files:** create `apps/web/features/settings/admin-settings.tsx`; modify `apps/web/features/settings/settings.tsx`, `apps/web/app/connect.tsx:80-95`.

- [ ] For admins only: a **Users** section (one row per user: email, role, action menu with promote, demote, remove) with an **Invite** action that shows the link to copy, and pending invites with revoke; a **Server** section with rows for Sign-up (toggle), Workspace size, Coding image, Question grace period, each edited in an `EditorSheet`.
- [ ] `connect.tsx` reads `?invite=`, sends it with `signUp.email`, and after sign-up offers adding a passkey. With sign-up off and no invite, it shows sign-in only.
- [ ] Run `bun run typecheck`, `bun test apps/web`. Expected: pass.

### Task 4: Workspace size and image from settings

**Files:** modify `src/app/server.ts:113-163`, `src/app/tenant.ts:86`, `src/app/builtin-plugins.ts:26-27`, `src/workspaces/microsandbox-workspaces.ts:47-80,256`, `src/workspaces/railway-workspaces.ts:69,171,235`, `src/workspaces/machine-workspaces.ts:110`.
**Interfaces:**

- Consumes: Task 1 `ServerSettingsStore`.
- Produces: `WorkspaceSettings = () => { cpus: number; memoryMib: number; image: string | undefined }` passed from the host to each tenant's workspace backends; read on every boot.

- [ ] Replace `MEMORY_MIB`/`CPUS` and `DEFAULT_RESOURCES` with the settings at boot (Railway: `{ cpu: cpus, memoryGB: memoryMib / 1024 }`).
- [ ] `imageFor` returns the settings image when set, else the environment image; the desktop image is unchanged.
- [ ] Run `bun test src/workspaces`. Expected: passes.

### Task 5: Reissue when idle

**Files:** modify `src/workspaces/machine-workspaces.ts:300-320,484,575`, `src/app/admin-api.ts`.
**Interfaces:**

- Produces: `POST /v1/admin/workspaces/reissue`; `GET /v1/admin/workspaces/reissue` returning `{ waiting: { userId: string; agentId: string }[] }`.

- [ ] Reissue records the current image as the target; `Workspace.boot` (`machine-workspaces.ts:301`) already switches images when `imageFor` differs.
- [ ] A running workspace with no job, turn, or `keepAwake` hold (`machine-workspaces.ts:575`) tears down and boots on the target now; others switch when their idle timer (`armIdleTimer`, `:484`) fires or on next boot.
- [ ] Test: Review focus 4.
- [ ] Run `bun test src/workspaces/machine-workspaces.test.ts`. Expected: passes.

### Task 6: Questions from coding jobs

**Files:** modify `src/jobs/coding.ts:28-46,76-123`, `src/jobs/jobs.ts`, `src/contract/api-contract.ts:525-532`, `apps/web/features/jobs/jobs.tsx`, `apps/web/features/chat/transcript.tsx`; test `src/jobs/coding.test.ts`.
**Interfaces:**

- Produces: tool `question` in the `coding-job` extension, `{ question: string }`, ends the job's turn (`control: { terminate: true }`, as `src/display/display.ts:125`); the job's report carries `question`; `POST /v1/agents/{id}/coding-jobs/{name}/answer` (`{ text: string }`) sends the answer to the job like `send`.

- [ ] Add the `question` tool and one instruction line: ask only when the answer changes the design or a decision is the owner's; otherwise proceed.
- [ ] The reporter delivers a question report to the bot chat as a question card, without a bot turn, and keeps the job's workspace awake (`keepAwake`) for `questionGraceMinutes`, released on answer or timeout.
- [ ] Job panel and chat card show the question with an answer box posting to the answer endpoint; an answered question shows the answer.
- [ ] Test: Review focus 3.
- [ ] Run `bun test src/jobs`. Expected: passes.

### Task 7: Learning review over coding jobs

**Files:** modify `src/skills/learning-review.ts:167-197,204-222`, `src/jobs/coding.ts:50`.
**Interfaces:**

- Consumes: `codingAnswers` (`src/jobs/coding.ts:50`); job reports reach the chat without an execution (`src/bots/bots-activity.ts:73-75`), so `afterExecution` never sees them.
- Produces: `LearningReview.afterJob(agentId: string, jobConversationId: ConversationId)`.

- [ ] Subscribe `learningReviews` to delivered coding job reports (not question reports) and review the job's conversation with the bot's review settings; changes record as learned changes with the job as source.
- [ ] Run `bun test src/skills/learning-review.test.ts`. Expected: passes.

### Task 8: Warm repositories

**Files:** modify `src/jobs/coding.ts:38-44,84-100`.

- [ ] Instructions: before cloning, check for an existing clone in `/workspace`; fetch, branch from the remote default branch, and reinstall dependencies only when the lockfile changed.
- [ ] A section like `workspace_credentials` (`coding.ts:87`) lists git repositories under `/workspace` with their remote URL, read with one `bash` call at job start through the workspace.
- [ ] Run `bun test src/jobs/coding.test.ts`. Expected: passes.

### Task 9: Signed commits for machine accounts

**Files:** create `src/github-apps/ssh-signing.ts`, `workspace-image/crumble-ssh-sign`; modify `src/github-apps/schema.ts:63-69`, `src/github-apps/github-apps.ts:625-660`, `src/credentials/credential-proxy.ts`, `workspace-image/Dockerfile`, the machine account sheet in `apps/web/features/settings/coding.tsx`.
**Interfaces:**

- Produces: `sshSign(privateKey: KeyObject, data: Uint8Array, namespace: "git"): string` (armored SSHSIG, OpenSSH `PROTOCOL.sshsig`); machine account response gains `signingKey: string` (OpenSSH public key).

- [ ] Generate an Ed25519 key when a machine account is added (and for existing ones on first use); store the private key as a keyed secret like `githubAccountTokenKey`.
- [ ] `gitEnv` adds `gpg.format=ssh`, `user.signingkey=key::<public key>`, `commit.gpgsign=true`, `gpg.ssh.program=/usr/local/bin/crumble-ssh-sign` for a machine account identity.
- [ ] `crumble-ssh-sign -Y sign -n git -f <key> <file>` posts the file to `https://signing.crumble.internal/sign` and writes `<file>.sig`; other modes exit 1.
- [ ] The credential proxy answers `signing.crumble.internal` itself for its `agentId` with `sshSign` of the bot's machine account key.
- [ ] The machine account sheet shows the public key to add on GitHub as a signing key.
- [ ] Test: `sshSign` output verifies with `ssh-keygen -Y verify` when available (skip otherwise); Review focus 5.
- [ ] Run `bun test src/github-apps src/credentials`. Expected: passes.

### Task 10: Glossary and docs

**Files:** modify `GLOSSARY.md`, `apps/docs/content/concepts/workspaces.mdx`, coding job and machine account pages under `apps/docs/content/`, `docs/architecture.md`.

- [ ] Add **Admin** and **Invite link**; extend **Coding job** (questions) and **Machine account** (signing key).
- [ ] Docs: users and invites, server settings, reissue, job questions, signing setup.
- [ ] Run `bun run check` in `apps/docs` and `bun run check` at the root. Expected: pass.
