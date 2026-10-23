# Plugin interfaces

- Status: Accepted

Prepares a plugin system without building one. The first users are the Claude Code provider ([feature 0006](https://github.com/crumble-project/spec/blob/main/features/0006-claude-code-provider.md)) and the existing coding and desktop job kinds.

## Today

Extension points are hard-wired. `providers.ts` adds Melious to Pi AI's built-in catalog by hand. `server.ts` builds coding and desktop extensions per bot, `runtime.ts` and the API carry `codingJobs` and `desktopJobs` methods, and each job kind is a module that calls `defineJobKind` and exports its own helpers. Adding a provider or a job kind means editing all of these.

## Decision

A plugin is a compiled-in module that exports a factory returning one `CrumblePlugin` (`src/plugins.ts`). `builtinPlugins` (`src/builtin-plugins.ts`) holds the static list and hands each factory only the part of `PluginHost` it needs; the server reads contributions from the list instead of naming modules.

```ts
type CrumblePlugin = {
  /** Stored data and settings key on it. Never rename. */
  id: string;
  providers?: ProviderContribution[];
  jobKinds?: JobKindContribution[];
};

type ProviderContribution = {
  /** A Pi AI provider; its `api` streams are the adapter. */
  provider: Provider;
  /** For providers that sign in outside Crumble: their state, shown instead of sign-in methods. */
  externalAuth?: () => Promise<ExternalAuth>;
};

type JobKindContribution = {
  kind: string;
  enabled: (agent: Agent) => boolean;
  extensions: (agent: Agent) => JobExtensions;
  env: (agentId: string, target: EnvTarget, context: Context) => Promise<ExecutionEnv | undefined>;
  onAnswer: (listener: (answer: JobAnswer) => void) => () => void;
};
```

- **Providers stay Pi AI providers.** `createProvider` with a custom `ProviderStreams` is already the adapter seam. Availability that depends on something outside Pi AI, such as an installed executable, goes through the provider's own `auth.apiKey.check`, so `configured` and the model list follow it without new plumbing. `providerModels(credentials, contributions)` registers every contribution with `models.setProvider`. Melious moved into a plugin unchanged.
- **External sign-in is data.** `ExternalAuth` names the state, the installed and qualified versions, and the sign-in and sign-out commands, mirroring Hermes' `external_dependencies` and setup status. The API returns it as `Provider.externalAuth` and refuses to delete a credential Crumble does not hold; nothing installs or signs in for the owner.
- **Job kinds wrap `defineJobKind`.** Coding and desktop are contributions offered only while their workspaces exist. The server builds chat and job extensions, job environments, and answer notifications by iterating them, so `taskExtensions` no longer names kinds.
- **Narrow host interfaces.** Plugin factories take only what they need (the data directory and environment, workspaces, desktop control), never `CrumbleService` or `Store`. That surface is what a loadable plugin would later be versioned against.

## Not decided here

Loading plugins from outside the codebase. That needs a manifest (ID, version, required host API version, requirements, settings schema), a trust and sandbox model for third-party code, and per-plugin settings storage. Hermes' `plugin.yaml` is a reference for the manifest fields. It gets its own ADR once a second-party plugin exists.

## Considered options

- **Pi AI `models.json` custom providers.** Rejected for Claude Code: they configure HTTP endpoints and cannot spawn a process or check an executable.
- **Dynamic loading now.** Rejected: no stable host API exists yet, and loading code from disk needs the trust model above first.
- **One generic `extensions` hook per plugin.** Rejected: it hides what a plugin contributes, so the server could not list providers, check requirements, or route job APIs by kind.

## Consequences

- The job API keeps its kind-specific routes (`/coding-jobs`, `/desktop-jobs`) within contract 1.x; only the wiring behind them becomes generic.
- `JobKindOptions.kind` and plugin IDs become persistent identifiers, like they already are for stored job data.
- A contribution that throws while building is a startup error, not a skipped plugin, until a loader with isolation exists.
- Catalog-only callers without a server (`providerModels()` with no contributions) get only the providers that need no server configuration; Claude Code needs the data directory.
