# Lint pass 1: findings that need a design decision

Date: 2026-11-11
Companion to `2026-11-11-lint-pass-1-fixes.md`. These are the 668 findings left after the mechanical fixes; none of them is a one-line change, and several are questions about what the codebase wants to be rather than about lint.

## 1. The Effect rules are the whole remaining payload (531 findings)

| rule | count | severity |
| --- | --- | --- |
| `effect/noThrowStatement` | 287 | error |
| `effect/noTryCatch` | 138 | warning |
| `effect/noNewPromise` | 106 | warning |

Cluster, by directory (`apps/server/src`): providers 44, history 25, files 18(+11), app 18, bot-desktop 16, workspaces 12, shared 12, bots 12.

Three different situations are lumped together, and they need different answers:

1. **`throw` inside an `Effect.gen`** (e.g. `skills/skill-library.ts`, `github-apps/github-api.ts:92`). These want tagged error classes and `Effect.fail`, i.e. a change to each service's error type and to every caller that matches on it. Doing this per module is straightforward; doing it repo-wide changes the error contract of the API layer (`app/api-errors.ts`).
2. **`throw` in code that is not Effect at all** — TanStack route loaders (`apps/web/app/router.tsx:74,85,271` use `throw redirect(...)`, which is the library's documented control flow), CLI scripts under `apps/server/tools/`, and `apps/server/test/fixtures/`. The rule is `error` globally, but these files cannot satisfy it without moving to Effect or restructuring the loader. Proposal: scope `effect/*` to `apps/server/src/**` and turn `noThrowStatement` off for `apps/web/app/**`, `apps/server/tools/**`, `apps/server/test/**`, or accept per-file disables with a stated reason.
3. **Promise and `try`/`catch` at I/O boundaries** (`new Promise` around SDK callbacks, `try`/`catch` around `fetch`, child-process, sandbox SDKs). These are mostly already inside `Effect.gen` and want `Effect.tryPromise` / `Effect.acquireUseRelease` / `Effect.ensuring`. That is real refactoring of ~10 modules (claude-code provider, microsandbox/railway workspaces, files, bot-desktop), not a sweep.

Recommendation: take (1) module by module as those files are touched, decide (2) as a rule-scope policy first, and schedule (3) as its own change per subsystem.

## 2. `effect/noModuleMocks` (31 findings, all in `apps/web/**/*.test.tsx`)

`composer.dom.test.tsx` (8), `message-gateways.dom.test.tsx` (4), and five more tests replace whole modules with `mock.module(...)`. Passing this rule means giving those components injectable dependencies (a props/seam for `send`, the API client, `useQuery`), which is a testability refactor of the component layer, not a lint fix. It may also be the point where the rule is declared "for tests, mocks are the design" and turned off for `**/*.test.*`.

## 3. Untyped boundaries: `no-unsafe-assignment` (57) and `no-unsafe-return` (11)

Every one of these is an `any` arriving from outside the type system. Three roots:

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

- `ignorePatterns` lists `**/*.test.ts` but not `**/*.test.tsx`: 93 findings (30 of the 31 `noModuleMocks`) come from web tests that are linted where server tests are not. Either that asymmetry is intended (browser tests do exercise more) or the pattern should be `**/*.test.{ts,tsx}`.
- `oxlint --fix` on this tree is currently unsafe: it strips required `undefined` arguments (see the pass-1 log). Anyone running `bun run fix` (which is `oxlint --fix`) will get 47 type errors until `unicorn/no-useless-undefined` is either configured as above or fixed by hand.
