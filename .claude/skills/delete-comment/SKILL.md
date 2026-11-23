---
name: delete-comment
description: Review and remove a batch of code comments while preserving decisions and tracking implementation debt.
disable-model-invocation: true
---

# Delete comments

1. Read the repository instructions and `docs/comment-cleanup.md`. Inspect the working tree; preserve unrelated changes.
2. Run `bun run --silent comments:inventory` and save the JSON output in a temporary file. Read each selected file and the referenced code. Inventory messages contain comment text and SHA-256 fingerprints. Work in coherent batches; when zero is requested, continue until a fresh inventory has zero diagnostics. A completed batch is not a stopping condition.
3. Classify every comment in the batch:
   - **Tautology:** repeats facts directly visible in the adjacent code. Remove it.
   - **Stale:** contradicts verified current behavior or references something removed. Record the evidence and remove it.
   - **Excuse:** rationalizes specific unresolved implementation debt. Verify the debt, search existing issues, draft using the repository template, and show the draft before filing. Follow `SECURITY.md` for private reporting. A narrow fixture or unavoidable platform constraint is not automatically an excuse. Remove the comment without silently fixing unrelated logic.
   - **Decision Record:** preserves a consequential, non-obvious choice or contract. Verify it, then move its rationale to an existing relevant ADR or a sequentially numbered ADR in `docs/adr/`. Avoid duplicating an existing record.
4. Replace tooling comments with equivalent configuration or metadata before deleting them. Migration groups belong in `statements.json`; type references and lint exceptions belong in external config. Preserve legal attribution in a license-compliant distribution location. If a license requires an inline notice, report that blocker rather than violating it. Shell shebangs remain executable interpreter metadata.
5. Use targeted edits or reviewed parser spans. Oxlint offsets are UTF-8 bytes: use byte buffers, not JavaScript string slicing. Preserve token separators and remove entire empty JSX comment containers. Verify parsing and executable AST equivalence where practical. Regex-only bulk deletion is unsafe.
6. Keep `tools/comment-baseline.json` empty. If reviewing an older nonempty ratchet, remove each deleted fingerprint occurrence and empty file entry. Never grant, transfer, or replenish allowances.
7. Extend the audit ledger with each original path, line, fingerprint, category, action, and ADR or issue reference. Mark drafts awaiting approval and unreviewed comments explicitly. Refresh the remaining counts and estimate.
8. Run `bun run lint:comments`, project lint, formatting, type checks, and applicable existing tests. Verify added line, block, JSX, inline HTML-script, and non-JS comments fail. URLs and comment-like string data must remain accepted. Check the final inventory again after builds or generators. Keep temporary verification artifacts outside tracked source.
9. Report the reviewed and pending counts, physical source lines removed, ADRs, issue links or drafts, and failed or skipped checks. Separate gross source-line savings from documentation and baseline growth. Show human-facing Markdown with Leaf using the repository handoff instructions.

Oxlint parses JS/TS, JSX/TSX, and inline HTML scripts. The companion lexical scanner covers the repository's other source/configuration syntaxes; it is not a full compiler. Dependencies, ignored generated/build outputs, and Markdown prose are outside the owned-source inventory. Treat unreviewed material as pending, never as a keyword-classified result.
