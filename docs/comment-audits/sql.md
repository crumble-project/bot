# SQL comment audit

SQL comments are absent from `apps/server/drizzle/**/migration.sql` and `apps/server/test/fixtures/*.sql`. Drizzle statement boundaries are retained as offsets in adjacent `statements.json` metadata, not as SQL markers. Historical migration hashes are retained in that metadata so databases that already recorded those hashes do not rerun migrations. The migration loader verifies source hashes and ordered breakpoint offsets before reconstructing the execution parts.

Ordinary SQL comments are removed outside quoted SQL strings and identifiers. Comments are not stripped by semicolon splitting: Drizzle's own breakpoint groups are captured before normalization, including groups containing multiple SQL statements or statements that must not be combined.
