# Crumble landing page

Landing page for Crumble, served at `https://crumbli.ng`. Built with TanStack Start, React, and Panda CSS, and rendered on a Cloudflare Worker.

The site has its own `bun.lock` and is not part of the root Bun workspace, so its dependencies stay out of the server's install and Docker image. Run every command below from `apps/site`.

## Local development

```sh
bun install --frozen-lockfile
bun run dev
```

`bun install` runs `panda codegen`, which generates `styled-system/`. Design tokens and global styles live in `panda.config.ts`.

## Verification & build

```sh
bun run build        # Build the client and Worker, then type-check
bun run preview      # Serve the production build in the Workers runtime
bun run deploy:check # Build and dry-run the Cloudflare deployment
```

The Site workflow runs `build` when `apps/site` changes.

## Deployment (Cloudflare Workers)

The Worker (`wrangler.jsonc`) is attached to `crumbli.ng`:

```sh
bun run deploy
```
