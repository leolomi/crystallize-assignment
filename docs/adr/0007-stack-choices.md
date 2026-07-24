# ADR 0007 — Stack: Bun, Drizzle, NestJS, workspaces

**Status:** accepted

## Runtime: Bun

Single toolchain for running TypeScript directly (no build step), the test
runner, and the package manager. The runner is spawned as `bun run <entry>`.

## Persistence: Drizzle on `drizzle-orm/bun-sql`

Typed schema and queries with `casing: 'snake_case'`, migrations via
`drizzle-kit generate` / `migrate`. Bun's native SQL driver is the runtime
client; `pg` is a dev-only dependency because `drizzle-kit migrate` needs a Node
driver. The claim, the resume query, and the checkpoint flips are all expressed
in Drizzle (with raw `sql` where the builder can't express `FOR UPDATE SKIP
LOCKED` or `CASE`).

### One sharp edge: jsonb double-encoding

With Drizzle's built-in `jsonb()` column on the Bun SQL driver, inserted
objects land as jsonb **strings** (`jsonb_typeof(payload) = 'string'`,
`payload->>'id' = NULL`): Drizzle's mapper runs `JSON.stringify` before
handing the value to the driver, and Bun's driver serializes that string
again. The value round-trips through the *same* driver (it parses twice on
read), which hides the bug until any SQL JSON operator or another client
touches the column. Fixed with a custom type
([`jsonb-object.ts`](../../packages/database/drizzle/schema/jsonb-object.ts))
that passes objects through unchanged in both directions and lets the driver
do the single, correct serialization. Same DB column type, no migration diff.

## Structure: Bun workspaces, one process per entrypoint

`apps/api` (HTTP ingest + status) and `apps/worker` (one deployable, two
entrypoints: dispatcher and runner — they always deploy together, the spawn is
by file path). Shared code lives in packages: `@crystallize/tasks` (the domain
contract: kinds, payload schemas, repositories), `@crystallize/database`
(Drizzle schema + wiring), `@crystallize/mongo` (connection wiring),
`@crystallize/shared` (config/logging/bootstrap utils). No build step —
cross-workspace imports resolve through the root tsconfig paths.

## Framework: NestJS, idiomatically

DI makes the shared modules reusable across all entrypoints; the runner and
dispatcher boot a headless `NestFactory.createApplicationContext`, the API a
full HTTP app. Configuration is `@nestjs/config` with typed `registerAs`
namespaces validated by zod at boot (fail fast, cross-field invariants
included); the dispatcher's poll and sweep intervals are registered on
`SchedulerRegistry` (config-driven cadence — decorator arguments are static),
started in `onApplicationBootstrap` and torn down by shutdown hooks. The one
deliberate exception: the runner handles SIGTERM/SIGINT manually rather than
via `enableShutdownHooks`, because its contract is drain-then-finish — Nest's
signal handling would close the context (and exit) while rows are in flight.
