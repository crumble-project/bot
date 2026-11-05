# Feature wiring

- Status: Accepted

A feature's code lives in its folder, but adding one still meant editing the account's central wiring. Across eight features, `tenant.ts` and `api.ts` changed six times each, and `drizzle.store.config.ts` four times. This decides what a feature declares itself and what stays central.

## Before

- **HTTP routes.** `createAPI(service, scheduler, token, integrations, options, push)` called 19 `register*Routes` functions by name. `ApiOptions` carried 17 fields (`scriptRuns`, `botRequests`, `groupChats`, `commonSkills`, ...), and `createTenant` filled each by hand from services the account's Context already held.
- **Schema.** `drizzle.store.config.ts` listed 15 schema files by path.
- **Layers.** `accountLayer` chained feature layers with `Layer.provideMerge` in dependency order, with unnamed groups.

## Decision

- **The API reads the account's services itself.** `createAPI(service, token, options)` reads every service its routes need from the Context of `service.core`, typed `Runner<ApiServices>`, so a layer the tenant forgets is a compile error. `options` holds only what is not a service: viewer tickets and the OAuth client document. A new feature that reads its service from the account adds it to `ApiServices` and a lookup in `apiContext`, and no line in `createTenant`.
- **Fixtures supply services.** `testAPI` in `test/support/api.ts` builds the same Context with real or test services, one line per call site, so no route has a test-only answer.
- **Routes register from a typed list.** `featureRoutes` in `api.ts` holds every feature's register function, called in order with one context (`apiContext`). TypeScript checks each entry against that context, so a register function declares the part it needs as its own options type. A new feature adds one entry.
- **Schema files are found by name.** The store config collects every `schema.ts` and `schema.<part>.ts` under `src/`, except `push/`, which has its own database. The two files that broke the pattern became `bots/schema.executions.ts` and `automations/schema.script-runs.ts`; they stay separate from their folder's `schema.ts` because merging would make `bots/schema.ts` and `automations/schema.ts` import each other. A file named `auth-schema.ts` holds no store tables and does not match. Encrypted tables stay a list in `product-layer.ts`: an encrypted column must be a visible decision, and a test fails when a repository encrypts into an unlisted table.
- **Layers stay explicit, in named tiers.** `accountLayer` names its groups (`leaves`, `conversations`, `sandboxedTools`, `signIns`) and chains the tiers top to bottom; each may use every tier below it, and the account closes them top first. Tiers stay written out, never one list of feature layers, because Effect checks layer requirements only on concrete types: a list widened to `Layer<any, ...>` would turn a missing dependency from a type error into a startup failure.

## Considered options

- **One `CrumbleFeature` descriptor per folder** (`{ layer, routes, schema, tools }`) that the app iterates. Rejected: an array of descriptors loses the layer types, as above, and layers need an order that the list would hide.
- **Routes that read services only through test layers.** Rejected: tests would need fake `Workspaces`, `Scheduler`, and sign-in services where today one function or value is enough.
- **Discovering feature folders at startup** (glob imports). Rejected: it hides what the server runs and defeats type checks.
- **Glob patterns in the store config.** Rejected: `src/*/schema.ts` also matches `push/schema.ts`, which belongs to another database.

## Consequences

- `apiContext` is the one place that knows which services the API reads. A feature whose routes need a new service adds it there and to `ApiServices`.
- A fixture must supply what its routes reach; `testAPI`'s defaults answer as an empty account.
- The tier order is still central and needs care when a feature depends on another; the names make it readable, not automatic.
- Renaming the two schema files changed no table; drizzle-kit generates no migration.
