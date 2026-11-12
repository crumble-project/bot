# Lint pass 1: quick fixes

Date: 2026-11-11
Baseline: `bun run lint` (`oxlint --deny-warnings`, type-aware) reported 866 findings.

```
287  error    effect(noThrowStatement)
152  error    unicorn(no-useless-undefined)
138  warning  effect(noTryCatch)
106  warning  effect(noNewPromise)
 58  error    typescript(no-unsafe-assignment)
 39  error    eslint(no-nested-ternary)
 31  error    effect(noModuleMocks)
 21  error    typescript(consistent-type-imports)
 11  error    typescript(no-unsafe-return)
 11  error    typescript(no-unnecessary-type-assertion)
  8  error    typescript(switch-exhaustiveness-check)
  1  warning  eslint(max-depth)
  1  warning  eslint(complexity)
```

After pass 1: 668 findings. 129 files changed, all in `apps/` and `tools/`.

## Fixed

**`typescript/consistent-type-imports` (21).** `oxlint --fix`. Import lists split into value and `import type`; `bun fmt` tidied the result.

**`typescript/no-unnecessary-type-assertion` (11).** `oxlint --fix`, plus two follow-ups the fixer could not do:

- `apps/server/src/contract/chart.ts`: `lineJoin`'s transform now declares `: "miter" | "round" | "bevel"`, so `apps/web/features/chat/display.tsx` no longer needs the assertion on `strokeLinejoin` (React's SVG props rejected the widened `string`).
- `apps/server/src/learning/learning-review.ts`: dropped the assertion, its now-dangling `SAFETY:` comment, and the two imports it kept alive.
- `apps/server/test/fixtures/crash-server.ts`: dropped the `as any` on `provider: "faux"`; the comment above it was `SAFETY:`-prefixed and removed with it.

**`unicorn/no-useless-undefined` (114 of 152).** `return undefined;` became `return;` where the function's type allows it, `() => undefined` became `() => {}` where the return value is unused, and `.catch(undefined)` on zod schemas went through `.catch(() => undefined)` (zod requires the argument, and its absence is a type error) before settling back on `.catch(undefined)` with the rule's `checkArguments` off; see the architectural findings doc.

**`eslint/no-nested-ternary` (39, all).** Each nested chain became an early-return helper (`targetLabel`, `callStateOf`, `authOf`, `memberOf`, `markOf`, `replyToOf`, `modelsHint`, `secretInputOf`, `avatarState`, `titleOf`, `contentOf` in three components, `afterOf`, `replyOf`, `commandOf`, `actionOf`, `screenshotMode`, `dashOf`, `missOf`, `outcomeError`) or a short if-chain. JSX branches use explicit `if`/`return` inside the render helper instead of chained `?:` on elements.

One refactor had to be redone: `applyBulkAction` in `apps/web/features/skills/bulk-skill-actions.ts` selects its per-skill applier *synchronously*, because the tests observe the first fetch before awaiting anything. An `await`ed helper broke that; it is now `let apply = assigner; if (...) apply = ...`.

**`eslint/complexity` (1).** `parseRequestId` in `apps/server/src/shared/request-ids.ts` now looks the prefix up in a `PREFIXES` map of parsers instead of a 15-case switch. Behaviour is unchanged; an unknown or missing prefix is still `{ kind: "other" }`.

**`eslint/max-depth` (1).** `apps/server/src/contract/openapi.ts`: `checkArtifacts`/`writeArtifacts` extracted from the `import.meta.main` block.

**`typescript/switch-exhaustiveness-check` (7 of 8).** `askingBot`, `turnSource`, `Bots`'s `origin`, `missOf`, `scrollDelta`, and `switchedTo` were switches with a `default` that only handled "none of the above"; each is now an if-chain with the same fallback. `parseRequestId`'s prefix switch disappeared with the map above.

## Left in place, with a disable comment

- `apps/server/src/display/chart-runtime.ts:136` — switch over `svgpath` segment letters. `abs()`, `unshort()`, and `unarc()` leave only `M L H V Q C Z z`, but the library's segment union still lists every SVG letter, so the check cannot pass without 13 dead cases. One `oxlint-disable-next-line` with that reason.

## Verification

- `bun run typecheck` — clean.
- `bun run format:check` — clean.
- `bun run openapi:check` — clean.
- `bun run agents:check` — clean.
- `bun run test` — 1261 pass, 118 skip, 0 fail (1379 tests).

## A hazard worth knowing

`oxlint --fix` applies `unicorn/no-useless-undefined` in argument position, which breaks required arguments: it turns `.catch(undefined)` (zod) into `.catch()`, `Deferred.succeed(done, undefined)` into `Deferred.succeed(done)`, `Queue.offer(due, undefined)` into `Queue.offer(due)`, and so on. A run of plain `oxlint --fix` on this tree produced 47 type errors that way. Use `oxlint --fix -A unicorn/no-useless-undefined` and fix that rule by hand.
