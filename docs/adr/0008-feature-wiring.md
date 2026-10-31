# Feature wiring

- Status: Accepted

A feature's code lives in its folder, but adding one still meant editing the account's central wiring. Across eight features, `tenant.ts` and `api.ts` changed six times each, and `drizzle.store.config.ts` four times. This decides what a feature declares itself and what stays central.

## Before

- **HTTP routes.** `createAPI(service, scheduler, token, integrations, options, push)` called 19 `register*Routes` functions by name. `ApiOptions` carried 17 fields (`scriptRuns`, `botRequests`, `groupChats`, `commonSkills`, ...), and `createTenant` filled each by hand from services the account's Context already held.
- **Schema.** `drizzle.store.config.ts` listed 15 schema files by path.
- **Layers.** `accountLayer` chained feature layers with `Layer.provideMerge` in dependency order, with unnamed groups.

## Decision

- **The API reads the account's services itself.** `createAPI(service, token, options)` looks up each service its routes need in the Context of `service.core` with `Effect.serviceOption`, which adds no type requirement (`accountOptions` in `api.ts`). The tenant passes a runner over the whole account and only the values that are not services: the scheduler access, viewer tickets, and the OAuth client document. A service the Context lacks gives `undefined`, so its routes answer 503 as before.
- **`ApiOptions` overrides; it does not plumb.** Any value in `options` replaces the one read from the account. Tests keep passing the same fakes as before, now as `createAPI(service, token, { scheduler, groupChats })`: one line per call site, no test layers. A new feature that reads its service from the account adds a lookup in `accountOptions` and no line in `createTenant`.
- **Routes register from a typed list.** `featureRoutes` in `api.ts` holds every feature's register function, called in order with one context (`apiContext`). TypeScript checks each entry against that context, so a register function declares the part it needs as its own options type. A new feature adds one entry.
- **Schema files are found by name.** The store config collects every `schema.ts` and `schema.<part>.ts` under `src/`, except `push/`, which has its own database. The two files that broke the pattern became `bots/schema.executions.ts` and `schedules/schema.script-runs.ts`; they stay separate from their folder's `schema.ts` because merging would make `bots/schema.ts` and `schedules/schema.ts` import each other. Files named `auth-schema.ts` or `legacy-schema.ts` hold no store tables and do not match. Encrypted tables stay a list in `productLayer`: an encrypted column must be a visible decision.
- **Layers stay explicit, in named tiers.** `accountLayer` names its groups (`leaves`, `conversations`, `sandboxedTools`, `signIns`) and chains the tiers top to bottom; each may use every tier below it, and the account closes them top first. Tiers stay written out, never one list of feature layers, because Effect checks layer requirements only on concrete types: a list widened to `Layer<any, ...>` would turn a missing dependency from a type error into a startup failure.

## Considered options

- **One `CrumbleFeature` descriptor per folder** (`{ layer, routes, schema, tools }`) that the app iterates. Rejected: an array of descriptors loses the layer types, as above, and layers need an order that the list would hide.
- **Routes that read services only through test layers.** Rejected: tests would need fake `Workspaces`, `Scheduler`, and sign-in services where today one function or value is enough.
- **Discovering feature folders at startup** (glob imports). Rejected: it hides what the server runs and defeats type checks.
- **Glob patterns in the store config.** Rejected: `src/*/schema.ts` also matches `push/schema.ts`, which belongs to another database.

## Consequences

- `accountOptions` is the one place that knows which services the API reads. A feature whose routes need a new service adds it there.
- A route registered without its service in an API-only fixture behaves as if the server lacked the feature, which is what the optional fields did before.
- The tier order is still central and needs care when a feature depends on another; the names make it readable, not automatic.
- Renaming the two schema files changed no table; drizzle-kit generates no migration.
