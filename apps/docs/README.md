# Crumble Documentation

Static documentation site for Crumble, built with [Blume](https://useblume.dev/) and served at `https://docs.crumbli.ng`.

The site has its own `bun.lock` and is not part of the root Bun workspace, so its dependencies stay out of the server's install and Docker image. Run every command below from `apps/docs`.

## Local development

Requires **Node.js 22.19+** and **Bun 1.4.4**.

```sh
bun install --frozen-lockfile
bun run dev
```

## Verification & build

```sh
bun run check        # Validate config, frontmatter, and internal links
bun run build        # Build static HTML, search index, and llms.txt into dist/
bun run deploy:check # Dry-run Cloudflare Workers deployment
```

The Docs workflow runs `check` and `build` when `apps/docs` changes.

## Deployment

A push to `main` that changes `apps/docs` deploys the site once `check` and `build` pass. The Docs workflow reads the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. To deploy by hand:

```sh
bun run deploy
```

## Writing docs

Pages live in `content/` as Markdown, or MDX for pages with Mermaid diagrams, with `title` and `description` frontmatter. Keep terminology aligned with [`GLOSSARY.md`](https://github.com/crumble-project/bot/blob/main/GLOSSARY.md), link to generated schemas in `openapi/`, and update the docs in the same pull request as the server change they describe.

### Style

- Open with one sentence that says what the thing is or what it decides.
- Write to "you", with contractions. Plain and dry; a short aside is fine, marketing isn't.
- Titles and headings in Title Case, as noun phrases or gerunds ("Adding a Login").
- Put comparisons, options, and limits in tables. Introduce each code block with a sentence ending in a colon.
- Mark warnings by bolding the key sentence, not with callout boxes.
- Handle problems inline where they happen: "If X, then Y is the cause. Do Z."
- Add a Mermaid diagram when a flow, decision, or lifecycle is easier to see than to read.
- End on a pointer to the next page or the last useful detail, never a recap.
