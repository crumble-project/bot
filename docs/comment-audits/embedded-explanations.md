# Embedded explanations

These two explanations were outside the initial standalone JS/TS and non-JS comment-token inventories: one was JavaScript inside HTML, and one was a Python docstring. The final linter parses inline HTML scripts. Python string literals are data rather than comment tokens; the redundant helper docstring was removed deliberately.

| Original location | SHA-256 | Category | Action |
| --- | --- | --- | --- |
| `apps/web/index.html:28` | `b1f9b51b58930eaa924c7788ee837360d290d81989e7de86b0146bcc44ae7e3c` | Decision Record | Removed; first-paint theme rationale in ADR 0016 |
| `apps/server/src/workspaces/railway/workspace-tunnel.py:57` | `34e70a78519e14722fd5c53506f8db53578b73760910e4b442f1f673f550d84d` | Tautology | Removed; restates the function body; no runtime docstring consumer |
