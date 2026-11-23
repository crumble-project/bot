# Validate agent steering paths during checks

Agents can follow paths in steering files without first checking whether those files still exist. `tools/agents-paths.ts` therefore fails the project check when a referenced path moves or disappears, instead of leaving broken instructions for a later agent session. This preserves the rationale previously documented in that checker.
