# Non-TypeScript comment audit

This is the grouped overview. The [303-span ledger](non-typescript-spans.md) supplies each comment's individual classification and fingerprint. SQL metadata has its own [audit](sql.md) and [ADR 0023](../adr/0023-comment-free-migration-metadata.md).

This pass covers the Python helpers (completed in the preceding pass) and eligible repository CSS, shell, Docker, YAML, JSON/JSONC, TOML, HTML, XML, SVG, gitignore/dockerignore, and Git hook files. Excludes Markdown, JavaScript/TypeScript, package manifests, lockfiles, generated/build/data files, and SQL migrations. Locations below are original line numbers before removal. For consecutive comment blocks, ranges identify all comment lines in that block.

| Original location | Category | Action |
| --- | --- | --- |
| `apps/server/src/workspaces/railway/railway-stream.py:1-2` | Decision Record | Removed; exec text/base64 behavior retained in `docs/adr/0005-railway-workspaces.md`. |
| `apps/server/src/workspaces/railway/workspace-tunnel.py:1-4,30,57` | Decision Record | Removed; protocol framing, shutdown, stale-process replacement, and connection lifecycle reasoning retained in `docs/adr/0005-railway-workspaces.md` (the short function docstring was redundant). |
| `compose.push.yaml:1-2`; `compose.kvm.yaml:1-3` | Tautology | Removed usage examples; compose files and required-variable errors remain the executable configuration. |
| `apps/web/styles.css:123,134,284`; `apps/web/shadcn-tailwind.css:27,97,533,641-642`; `apps/server/workspace-image/desktop/thunar-gtk.css:1` | Tautology / Stale | Removed section labels and styling explanations; declarations remain unchanged. The legacy unlayered shimmer rule remains in place, with its cascade/backward-compatibility rationale recorded in `docs/adr/0021-build-and-runtime-decisions.md`. |
| `apps/web/index.html:28` | Decision Record | Removed inline theme-script explanation; first-paint rationale is preserved in ADR 0016. Script behavior is unchanged. |
| `apps/server/workspace-image/desktop/browser.sh:2,5,13,16-18`; `desktop-start.sh:2-4,10,13,20,29,36,38,41,44,54`; `maximize.sh:2-3,6,8,17,24` | Tautology / Decision Record / Stale | Removed operational explanations and stale milestone/history references. Executable commands and flags remain unchanged; process-lifecycle, sandboxing, package-selection, and checkpoint-lock rationale is recorded in `docs/adr/0021-build-and-runtime-decisions.md`. |
| `Dockerfile:12-13`; `apps/server/workspace-image/Dockerfile:1-3,13,27,40,49-50,66` | Stale / Decision Record / Tautology | Removed prose descriptions. ADR 0021 records the actual lock boundary instead of preserving the stale cross-container claim, plus the verified image decisions. |
| `.github/workflows/check.yml:12,24,27`; `docs.yml:27,35,49`; `pr-title.yml:19`; `react-doctor.yml:1-2,7,10,29`; `server-image.yml:64`; `site.yml:26,28,35,49-50,55`; `workspace-image.yml:48` | Tautology / Decision Record | Removed workflow descriptions and rationale; job definitions and commands remain unchanged. Significant intended workflow behavior is expressed by workflow structure. |
| `.github/workflows/check.yml:17,20`; `docs.yml:20,23,43,46,50`; `pr-title.yml:15`; `react-doctor.yml:30,34`; `server-image.yml:38,56-59,64`; `site.yml:20,23,43,46,49`; `workspace-image.yml:27,40-41,44,49` | Tautology | Removed human-readable version suffixes from immutable action-SHA pins; SHA pins are unchanged. |
| `.githooks/check-conventional-commit.sh:2`; `.githooks/commit-msg:2,8`; `.githooks/pre-commit:2`; `.githooks/pre-push:2-3,30` | Tautology / Decision Record | Removed explanations; hook commands and behavior remain unchanged. |
| `.gitignore:1,4,9,13,18,25,30,33,36` | Tautology | Removed grouping labels; ignore patterns are unchanged. |
| `tsconfig.base.json:3,12,18,34` | Tautology | Removed setting-group explanations; compiler options are unchanged. |

No legal text, copyright notices, or third-party attribution comments were removed. `THIRD_PARTY_NOTICES.md` already covers `apps/web/shadcn-tailwind.css` as a shadcn 4.22.1 MIT-licensed copy and includes the copyright attribution and license text; no additional notice text is indicated. JSON/JSONC configuration files, HTML/XML fixtures, SVGs, and the remaining ignore files were inspected and contained no syntactic comments to remove. SQL migrations were handled separately; see the SQL audit and ADR 0023.

## Machine metadata retained

- Shell shebangs, required to select the interpreter: `.githooks/check-bun-version.sh:1`, `.githooks/check-conventional-commit.sh:1`, `.githooks/commit-msg:1`, `.githooks/pre-commit:1`, `.githooks/pre-push:1`, `apps/server/workspace-image/desktop/browser.sh:1`, `desktop-start.sh:1`, and `maximize.sh:1`.
- Removed root `Dockerfile:1` directive `# syntax=docker/dockerfile:1` after inspecting both Dockerfiles. Neither uses frontend-specific heredocs, mounts, or other syntax requiring that directive; no replacement is needed. The workspace-image Dockerfile has no syntax directive.

All eligible explanatory source comments are removed. The eight retained shebangs are executable interpreter metadata. The stale Docker lock claim was reconciled against the implementation and corrected in ADR 0021; it is not an unresolved documentation follow-up.
