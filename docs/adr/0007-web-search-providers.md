# Web search providers

- Status: Accepted

Bots have no web search: the Claude Code provider runs without built-in tools, and other providers bring none. Crumble ships its own web search and page reading behind web search providers, with Mixed as the default so search works on a fresh install with nothing set up. Research: [web search providers](../research/web-search-providers.md), [free web search services](../research/free-web-search-services.md).

## Decision

- **Two bot tools Crumble owns.** `web_search` takes a query and optional filters (domains, date range, result count) and returns title, URL, date, and an excerpt per result. `web_extract` takes URLs and returns page text. No provider or MCP detail reaches the tool schemas, so changing provider never changes what the bot sees. Filters a provider lacks are applied by Crumble or dropped.
- **Web search providers are plugin contributions**, a third kind next to model providers and job kinds ([ADR 0004](0004-plugin-interfaces.md)). A provider implements availability (a check without network), search, and extract, and may support only one of the two. One provider per vendor; a vendor that offers use without a key supports both modes, so Mixed reuses it.
- **Mixed is the default provider.** It rotates through vendors usable for free without a key: Exa (`https://mcp.exa.ai/mcp`), Parallel, and Tavily (keyless header) for search, and Jina Reader for extract. On a rate limit or refusal it moves to the next vendor. It never retries a vendor through another IP, account, or session, which Exa §4.2(i), Tavily §3.2(ix), and others forbid.
- **Account default with per-bot provider choice.** The owner chooses a default web search provider for the account; each bot can inherit it or use another provider. Provider keys belong to the account and are shared by its bots, encrypted with the account's key like provider credentials. Never one key per server: Parallel §2(b)(i) says one query's output is "for the use of one End Customer only". Not a credential: credentials belong to one bot and its workspace hosts.
- **Exa is the first single-vendor provider**, the documented step up when Mixed runs out: its free key needs no card and resets monthly. Brave follows as the privacy option.
- **Results are not shared across accounts.** Any cache is per account and short-lived, because of Parallel §2(b)(i), Brave §3(b)(i), and Exa §4.2(a).

## Considered options

- **A hosted MCP server added by the owner.** Rejected as the default: the MCP server's tool names and result shapes would become the bot's interface and change per vendor. MCP stays a transport some providers use internally.
- **Claude Code's built-in `WebSearch`.** Rejected: it only serves bots on that provider, Crumble runs `claude -p` without tools, and whether a subscription covers it is unknown.
- **Melious tools.** Not free (EUR 0.004 per search); can be a provider later.
- **Excluded from Mixed:** Keenable ("The Service is for your personal use only"; Hermes rotates through it anyway), `ddgs` (scrapes DuckDuckGo, Google, and Bing without permission), Gemini grounding (results may not be mixed with other results), and trial-only services. Firecrawl, You.com, and Wikipedia wait until their terms are read.
- **Free-tier keys inside Mixed.** Deferred: each vendor's terms need checking for quota stacking first, and the owner would have to mark a key as free so Mixed never spends money while looking free. Brave §3(b)(v), Serper, SearchAPI.io, and Cloudflare ban multiple accounts with one vendor.

## Consequences

- Mixed relies on free tiers whose limits are unpublished and which each vendor can change or withdraw. Every account on a server shares its egress IP and so, likely, those limits. Settings and docs say so and point to the Exa key.
- Mixed sends queries to several companies that may use them to improve their services (Exa §1(c), Parallel §4(b), Tavily §6.5). Settings and docs say so, and the owner can choose another provider.
- The same query can return different results depending on which vendor answered. Owners who need consistent results pick a single-vendor provider for the account or a bot.
- `web_extract` refuses private and internal addresses before any provider call.
- Open: whether a household sharing one self-hosted server is one customer or several under Brave §4(c) and Parallel §1(f).
