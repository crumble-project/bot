# Comment cleanup

## Result

**Zero comments remain in repository-owned source and configuration.** The final inventory scans tracked and nonignored untracked files, including tests, UI components, and inline JavaScript in HTML.

Dependencies, ignored generated/build output, and Markdown prose are outside this source scope. Eight shell shebangs remain because they select executable interpreters; they are not explanatory comments. No source-comment allowance remains: `tools/comment-baseline.json` is `{}`.

The original inventory contained 1,398 JS/TS comments across 398 files and 303 comment tokens in other source/configuration syntaxes. An inline HTML-script comment and one redundant Python docstring were also removed. The non-JS token count includes 169 active SQL separator directives, whose meaning moved into metadata instead of being discarded.

## Savings

- **1,973 comment-only physical source lines removed**, including otherwise empty JSX comment containers and the removed Python docstring.
- Comment text removed from another **138 code-bearing lines**, preserving their code.
- **831 fewer source/configuration lines net**, after adding enforcement and migration metadata.
- The repository as a whole grows by roughly 1,500 lines because the audit and ADRs preserve knowledge outside source. Gross comment deletion is not net repository shrinkage.

## Enforcement

`bun run lint:comments` runs the comment ban; `bun run lint` and `bun run check` include it.

Oxlint parses JavaScript, TypeScript, JSX, TSX, and extracted inline HTML scripts. A syntax-aware lexical scanner covers CSS, SQL, Python, shell/hooks, Dockerfiles, JSON/JSONC/web manifests, YAML, TOML, desktop entries, HTML/XML/SVG comments, and ignore files. Strings and literal data remain data, not comments. The scanner is repository tooling, not a full compiler for those non-JS languages; existing syntax/build checks remain necessary.

The JS/TS rule retains an empty fingerprint baseline. Exact-text, per-file occurrence allowances previously supported the ratchet; every allowance was removed as cleanup reached zero. Adding allowances is not an accepted way to introduce comments. Like other lints, this is a convention check, not protection against deliberately changing or disabling the checker.

`no-empty` still bans other empty blocks but permits intentional empty catches. Removing a comment must not force a no-op statement or change cleanup behavior merely to satisfy that rule. Rationale belongs in an ADR; actual unresolved error-handling debt is tracked separately.

To export comment text, fingerprints, and locations as JSON:

```sh
bun run --silent comments:inventory > /tmp/crumble-comments.json
```

Repeat cleanup with `/delete-comment`, defined in `.claude/skills/delete-comment/SKILL.md`. Batch work is an execution aid, not permission to stop above zero when zero is requested.

## Behavior-preserving replacements

- Twenty React Doctor suppressions moved to `apps/web/doctor.config.json` as file-and-rule overrides. These are broader than the original line-specific suppressions, but do not disable whole files or rules globally. ADR 0016 preserves their rationale.
- The site's Vite reference moved to `compilerOptions.types` in `apps/site/tsconfig.json`.
- Drizzle separators moved into 36 adjacent `statements.json` files. All 36 historical migration hashes and 205 exact SQL execution groups match the original source. The loader validates source hashes and breakpoint bounds. Generator wrappers preserve CLI options and normalize future migrations. See [ADR 0023](adr/0023-comment-free-migration-metadata.md).
- Hermes attribution and licenses remain in `THIRD_PARTY_NOTICES.md`; source-comment removal does not remove attribution obligations.
- Unneeded Docker frontend directives were removed; executable shell shebangs remain.

## Decisions and debt

Fourteen new ADRs, numbered 0010–0023, preserve verified consequential decisions. Existing ADRs 0005 and 0006 were updated where needed. Historical evaluation notes are labeled as historical evidence, not fresh performance guarantees.

- [Issue #155](https://github.com/crumble-project/bot/issues/155): unexpected tunnel shutdown failures are hidden.
- [Issue #156](https://github.com/crumble-project/bot/issues/156): verify password-manager SDK error contracts instead of leaving unverified assumptions in comments.
- One additional follow-up is tracked privately under `SECURITY.md`. Its identifier, affected component, and detailed audit are intentionally absent from this public-facing report.

The stale Docker lock claim was removed rather than promoted into an ADR as fact. The existing lock checks matching hostnames and does not guarantee exclusion across arbitrary containers sharing a volume; this cleanup does not fix that implementation.

A platform constraint or narrow test fixture is not automatically an Excuse. The audits distinguish legitimate decisions from specific unresolved debt rather than manufacturing issues for every cast or timeout.

## Audit index

Each original JS/TS comment fingerprint is accounted for in public or private audit records. Detailed infrastructure classifications are withheld as a whole under `SECURITY.md`, rather than identifying a sensitive entry. Consecutive explanations grouped in early records are reconciled with individual spans. Non-JS comments have a separate 303-span ledger.

- [Initial workspaces](comment-audits/initial-workspaces.md)
- [App/API routing](comment-audits/api-automations.md)
- [Contracts and automations](comment-audits/contract-automations.md)
- [Providers](comment-audits/providers.md)
- [Desktop and voice](comment-audits/desktop-voice.md), [remaining core](comment-audits/desktop-final-core.md), [desktop tests](comment-audits/desktop-final-tests.md), and [voice remainder](comment-audits/voice-final.md)
- [Bots and jobs](comment-audits/bots-jobs.md)
- [Credentials and identity](comment-audits/credentials-identity.md)
- [Infrastructure](comment-audits/infrastructure.md)
- [Other server features](comment-audits/server-features.md)
- [Web and site](comment-audits/web-site.md)
- [Reconciled spans](comment-audits/reconciled.md) and [embedded explanations](comment-audits/embedded-explanations.md)
- [Non-JS spans](comment-audits/non-typescript-spans.md), [non-JS overview](comment-audits/non-typescript.md), and [SQL metadata](comment-audits/sql.md)

## Verification

- Full `bun run check` passed: agent paths, lint, comment ban, formatting, server/web type checks, OpenAPI consistency, and tests.
- **1,272 tests passed, 118 opt-in tests skipped, 0 failed**; the full unit run took about 16 seconds locally.
- Tooling typecheck, docs checks, and the site build passed. The site build emits a CSS sourcemap warning.
- All 401 modified existing JS/TS files parse. After ignoring comments and empty JSX comment containers, 397 executable ASTs are unchanged. The four intentional differences are the migration integration, its upgrade fixture, equivalent code-point counting replacing a suppression, and lint configuration.
- Controlled checks reject added line, block, JSX, and non-JS comments in untracked files. They accept comment-like URLs, strings, regexes, templates, JSX text, and literal data. Inline HTML-script comments are checked through the JS parser.
- All 36 migration identities and 205 exact execution groups were independently compared with `HEAD`; modified source and out-of-bounds metadata are rejected.
- Ten existing YAML/JSON configurations preserve identical parsed data, excluding the four intentional tooling-config changes. Both Python helpers preserve executable ASTs after removing the redundant docstring.
- No billed workspaces, production data, real credentials, or paid inference were used. Live workspace/desktop suites and container image builds were not run. CI timing is unverified by these local checks.
