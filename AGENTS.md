# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `apps/server/node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `apps/server/node_modules/effect/src`.
Other server dependencies, such as `@earendil-works/pi-durable`, are under
`apps/server/node_modules/` too: Bun links packages per workspace, not at the root.

# Documentation and site

User-facing docs live in `apps/docs` (a Blume site) and the landing page in `apps/site` (TanStack Start). Each has its own lockfile, outside the root workspace. When a change alters behavior, settings, endpoints, or UI labels the docs describe, update the matching page in the same change and run `bun run check` from `apps/docs`.

# Contributing

Read `CONTRIBUTING.md` before you commit, open a pull request, change a database schema, or change the API contract.

# Web UI components

Add shadcn components with `bun run ui:add <component...>`, and update `apps/web/shadcn-tailwind.css` with `bun run ui:add --css <version>`. This replaces the shadcn CLI, which needs 558 packages to run.
