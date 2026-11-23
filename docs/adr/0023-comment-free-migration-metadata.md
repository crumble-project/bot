# Comment-free migration metadata

Status: Accepted

SQL migrations and schema fixtures contain no SQL comments. Drizzle's `--> statement-breakpoint` marker is executable migration metadata: it separates statements that must be executed independently (including PRAGMA and table-rebuild operations), so deleting it without preserving its boundaries can change migration behavior.

The source migration remains comment-free. Each migration with `statements.json` stores the historical Drizzle SHA-256, the SHA-256 of the normalized SQL source, and ordered offsets delimiting the original Drizzle statement groups. The normalizer splits on Drizzle's marker before removing ordinary SQL comments, preserves SQL strings and whitespace outside comments, and joins the cleaned groups without inserting marker text. The migration loader delegates migration discovery and timestamp/name metadata to Drizzle, validates the sidecar, verifies the cleaned source hash and ordered offset bounds, slices the exact groups, and restores the original hash. Thus already-applied migrations keep their historical identity while the executed SQL parts remain the original statements with comments removed.

The normalizer leaves valid existing metadata untouched after verifying its source hash; it fails rather than silently changing the identity of a normalized migration. New generated migrations must pass through it before use. A migration without a sidecar remains readable through Drizzle, supporting non-normalized migration folders during rollout.

This preserves active migration metadata without an exception to the comment-free source rule: rationale belongs in this ADR, and statement boundaries belong in validated sidecar metadata, never SQL comments.

## Historical migration decisions

- Baselines use `IF NOT EXISTS` so databases created before Drizzle can record the baseline without rebuilding their existing schema.
- A migration transaction prevents `PRAGMA foreign_keys=OFF` from taking effect. Avoid rebuilding credential tables where dropping them would cascade into credential-use history. SQLite column renaming also rewrites the associated CHECK expression, allowing that transition without a table rebuild.
- The Exa key moved into its plugin's setting, following [ADR 0009](0009-plugin-settings.md).
- Bot-owned GitHub Apps became account-owned Apps assigned back to their bots. Reusing each original bot ID preserves the identity of the migrated App row.
- Central credential rows keep their encrypted values unchanged. Provider API keys embedded inside encrypted JSON move through `ProviderCredentials` at startup, rather than through SQL that cannot decrypt those documents.
- Credentials and logins share request and use tables; kind-specific use fields live in `detail`.
- Canonical-avatar migration preserves definitions written by the earlier additive implementation instead of discarding existing owner data.
- Legacy SQL test fixtures represent the pre-Drizzle schema from commit `edccef9`, dumped from `sqlite_master`.
