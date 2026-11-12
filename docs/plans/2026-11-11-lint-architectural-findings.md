# Lint pass 1: findings that need a design decision

Date: 2026-11-11
Companion to `2026-11-11-lint-pass-1-fixes.md`. These are the 336 findings left after the mechanical fixes; none of them is a one-line change, and several are questions about what the codebase wants to be rather than about lint.

## 1. `effect/noThrowStatement` is off (287 findings, decided)

The rule is not in `.oxlintrc.json`. It counts every `throw` in the tree, and after measuring all 287 sites none of them sits in code where Effect owns control flow:

- 150 were in 57 files that contain no Effect at all (`providers/claude-code/adapter.ts` 23, `history/history-search.ts` 22, `display/charts.ts` 7, `message-gateway/discord/adapter.ts` 5, ...).
- 44 were in `apps/web/**`, `apps/server/tools/**`, and tests. `apps/web/app/router.tsx` throws `redirect(...)`, which is TanStack's documented loader contract.
- The remaining 67, in 24 Effect-adjacent modules, are still plain code: plain `async` methods caught upstream by `Effect.tryPromise` (`bots/runtime.ts`, `workspaces/*`, `integrations/*`), throws inside `Effect.try`/`Effect.sync` callbacks, where a throw is the failure signal itself (`files/file-store.ts`, `web-search/vendors.ts`, `shared/secret-box.ts`), and pi-ai tool `execute` bodies, whose contract is to throw (`skills/skill-library.ts`, `bots/reaction.ts`).
- Exempting the first two groups left exactly 0 sites inside an `Effect.gen`/`Effect.fn` body, so there was nothing left to convert.

The plugin's own README describes its policies as being for "Effect-native application code"; this server is plain TypeScript with Effect at the boundary, so the rule was measuring the boundary rather than a defect.

Decision: drop the rule, and let the `noTryCatch` / `noNewPromise` warnings below drive the conversion instead. They point at the same design, but they are satisfiable per module.

## 1a. Effect-native core: the migration (244 findings)

| rule | count | severity |
| --- | --- | --- |
| `effect/noTryCatch` | 138 | warning |
| `effect/noNewPromise` | 106 | warning |

Both are symptoms of one thing: plain helpers wrapped in `Effect.tryPromise`, `new Promise` around SDK callbacks, and `try`/`catch` around `fetch`, child processes, and sandbox SDKs. Converting a module to Effect removes its shares of both, and its `throw`s become `yield* new X(...)` as a side effect.

The unit of work is a vertical slice (module plus its callers), because the cost sits in the Hono handlers that would become `runPromise` calls or Effect handlers. Order by size of the fan-out, hardest last:

| slice | `throw`s | size | risk |
| --- | --- | --- | --- |
| `web-search/` (vendors, exa, mixed, provider, tools) | 5 | small | low |
| `files/file-store.ts` | 4 | small | low |
| `shared/secret-box.ts` | 6 | small, security-critical | medium |
| `group-chats/` | 5 | medium | medium |
| `workspaces/` | 12 | medium, SDK wrappers | medium |
| `bots/runtime.ts` | 11 | the harness seam | high |
| `providers/claude-code/adapter.ts` | 23 | streaming subprocess | high |

Two boundaries keep `throw` legitimately and should stay documented rather than fixed: pi-ai tool `execute` bodies (a promise contract) and the `try:` callback of `Effect.try`/`Effect.tryPromise` (a throw is how it becomes a typed failure).

## 2. `effect/noModuleMocks` is off (31 findings, decided)

The rule is not in `.oxlintrc.json`, for the same reason as `noThrowStatement`: it cannot see the code it is meant for.

`ignorePatterns` excludes `**/*.test.ts`, so the rule never runs on server tests, which is where this repository's Effect code is tested. All 31 hits were in `apps/web/**/*.test.tsx` plus one server test-support fixture, and every one was `spyOn`, not `mock.module`: 27 on `globalThis.fetch`, 2 on `crypto.randomUUID`, 1 on `console.error`, 1 on `window.removeEventListener`. Replacing a platform global is the only seam a browser DOM test has; the app has no Effect services to layer.

The two real `mock.module` uses are in files the ignore pattern hides: `web-search/mixed.test.ts:15` (replaces `./vendors`) and `password-managers/bitwarden.test.ts:26` (replaces the `@bitwarden/sdk-napi` SDK). If the rule is wanted, the order is: fix those two with seam services, then un-ignore `**/*.test.ts`, which also surfaces the rest of the test suite to the other rules (about 90 findings today).

## 3. Untyped boundaries: `no-unsafe-assignment` (54 left)

The 11 `no-unsafe-return` findings are fixed: each was an `any` (or `Promise<any>`) returned from a boundary, narrowed with an explicit `unknown` annotation or a typed tuple array, except `apps/web/lib/api.ts`, which trusts the route's OpenAPI shape and says so in a `SAFETY` comment.

Every remaining finding is an `any` arriving from outside the type system. Three roots:

- **`JSON.parse` on Drizzle text columns** — `apps/server/src/bot-store/agent-repository.ts` (8 findings) parses `tools`, `sharedSkills`, `mcpServers`, `inference`, `desktopModel`, `reviewModel`, `review` column by column; `learned-change-repository.ts`, `settings-repository.ts`, `script-runs.ts`, `bot-secret-uses.ts` do the same. The fix is one pattern: `$type<>()` on the column, plus a `jsonColumn(schema)` helper on read and write. It touches the schema and every repository that stores JSON, so it is a change of its own.
- **TanStack Router route types** — `apps/web/app/router.tsx` (18 findings). `useParams()` on a `createRoute` handle is `any` until the router is registered globally (`declare module "@tanstack/react-router" { interface Register { router: typeof router } }`). One file, but it can ripple through every `useParams`/`useSearch` call site, so it wants a deliberate attempt with typecheck in front of it.
- **Third-party boundaries** — `fetch(...).json()` in providers and web-search vendors, `Bun.spawnSync` in `tools/agents-paths.ts`. The last is a special case: `tools/` is in neither tsconfig, so tsgolint resolves it with an error program and reports "type `error`". Either give `tools/` its own tsconfig project (and add it to `bun run typecheck`) or exclude `tools/` from the type-aware lint.

## 4. `unicorn/no-useless-undefined` (38 left)

Two shapes, both of which *require* a literal `undefined`:

- **zod `.catch(() => undefined)`** (22 sites, mostly `transcript/entries.ts`, `transcript/tool-results.ts`, `bot-desktop/computer-use-*.ts`, `providers/melious.ts`). zod's `catch` takes a value or a callback; there is no no-argument form.
- **Effect/JS APIs with a required argument** — `Ref.make<T | undefined>(undefined)` (`bot-ports/bot-notices.ts`, `call-notes.ts`), `Effect.succeed(undefined)`, `Queue.offer(due, undefined)`, `piUsage(undefined)`, `agentInput.shape.instructions.parse(undefined)`, `Promise.resolve(undefined)` in `integrations/mcp-oauth.ts`.

Options, in increasing order of churn:

1. Narrow the rule: `"unicorn/no-useless-undefined": ["error", { "checkArguments": false, "checkArrowFunctionBody": false }]`. Written as a rule that only flags `undefined` in return position and object values, it stops producing false positives on required arguments. This is a config change, not a code change, and it silently covers 38 real sites.
2. 38 `oxlint-disable-next-line` comments with a reason each. Noisy, but every site stays visible.
3. Rewrite the Effect sites to carry `Option`/`void` instead of `T | undefined` (`Ref<Option<Handler>>`, `Effect<void>`), which is the idiomatic Effect answer and also removes the `undefined` entirely. This changes several service signatures (`CallNotes.note`, `BotNotices.notice`, `BotMessaging.jobsOf`) and their consumers.

## 5. Rule configuration observations

- `ignorePatterns` lists `**/*.test.ts` but not `**/*.test.tsx`: the web tests are linted and the server tests are not, which is the wrong way round for a repository whose Effect code lives behind server tests. This is why `noModuleMocks` had no valid target (section 2). If the asymmetry is unintended, the pattern should read `**/*.test.{ts,tsx}`, which surfaces about 90 findings today.
- `oxlint --fix` on this tree is currently unsafe: it strips required `undefined` arguments (see the pass-1 log). Anyone running `bun run fix` (which is `oxlint --fix`) will get 47 type errors until `unicorn/no-useless-undefined` is either configured as above or fixed by hand.
