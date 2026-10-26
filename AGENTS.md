# Learning more about Effect

This repository uses the Effect Typescript library.

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.

# Documentation

User-facing docs live in `apps/docs` (a Blume site with its own lockfile, outside the root workspace). When a change alters behavior, settings, endpoints, or UI labels the docs describe, update the matching page in the same change and run `bun run check` from `apps/docs`.
