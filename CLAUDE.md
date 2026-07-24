# CLAUDE.md

Bun-workspaces NestJS monorepo: a crash-safe bulk task runner where Postgres
is the queue. Read `README.md` for the design, `docs/adr/` for the decisions
(0002 → 0003 → 0004 is the correctness chain).

## Commands

```bash
bun install
bun run db:up            # postgres :5432 + mongo :27017 (compose --wait)
bun run db:migrate       # drizzle migrations
bun run start            # api + dispatcher together (workspaces --filter)
bun run api | dispatcher # one process each; runner: bun run runner <taskId>
bun run seed 50000 job.ndjson

bun test                 # unit only (*.spec.ts)
bun run test:integration # *.it-spec.ts against a throwaway docker stack
bun run typecheck        # tsc --noEmit
bun run lint / lint:fix  # biome
bun run db:generate      # regenerate migration after a schema change
```

Always run `typecheck`, `lint`, `bun test`, and `test:integration` before
calling a change done. After `db:generate`, run `lint:fix` (generated meta
files need formatting) — and note the integration stack applies migrations
from scratch, so it validates them.

## Layout

- `apps/api` — HTTP ingest (NDJSON streaming) + status endpoints
- `apps/worker` — one deployable, two entrypoints: `src/dispatcher` (poll +
  claim + route + sweep) and `src/runner` (one-shot, one per heavy task);
  `src/runner/execution.module.ts` is the execution core shared by both paths
- `packages/tasks` — domain contract: kinds, payload schemas, repositories
- `packages/database` — drizzle schema + migrations + pool wiring
- `packages/mongo`, `packages/shared` — connection / config / logging utils

## Invariants (do not weaken)

- **Effect before flip.** A row's Mongo effect is applied first, then the
  `pending -> done` flip commits separately. Never reverse the order.
- **Effects are idempotent, never rolled back.** They live outside any
  Postgres transaction; payloads carry absolute state (a price), never deltas.
- **Every runner write is epoch-fenced** — including the failure path.
  `markRowDone` and `recordRowFailure` carry the same two guards
  (`status = 'pending'` + epoch EXISTS); any new runner write must too.
- **A missed write is disambiguated**, not treated as fatal: epoch moved →
  stand down; epoch held → a same-claim peer settled the row, skip it.
- **The claim is the delivery mechanism.** `pending -> starting` via
  FOR UPDATE SKIP LOCKED; a task the dispatcher cannot execute right now
  stays `pending` (the claim only asks for weights with a free lane).
- **External calls must be bounded** (Mongo `timeoutMS`, drain deadline).
  The heartbeat proves the process is alive, not that it progresses — an
  unbounded call makes a live zombie the sweeper will never reclaim.
- **Connection budget**: api + dispatchers + runners × pool ≤ Postgres
  `max_connections`, and a process's pool must cover its own parallelism
  (boot-checked in `runner.config.ts` / `dispatch.config.ts` — keep the
  arithmetic comments in sync when touching caps or pools).

## Conventions

- Config: one zod-validated `registerAs` namespace per concern, typed access
  via `ConfigType` + `@Inject(xConfig.KEY)`; cross-field invariants fail the
  boot. Every value has a localhost default; `.env` only overrides.
- `RunnerService` holds per-run state: never a singleton, never `new` it —
  build instances through `RUNNER_FACTORY`.
- Log messages: capitalized, ids in brackets (`Task [id] ...`), details in
  parentheses. Comments/docs in English; comments state constraints and
  reasons, not narration.
- Never write `if (!(await ...))` — extract a named const first.

## Tests

Two tiers, split by filename (keep the suffixes exact — `bun test`'s pattern
is what excludes integration specs from the unit run):

- `*.spec.ts` — **unit**, colocated with the source, no infra. For pure
  logic: stream parsing, weight classification, pool/loop primitives, the
  dispatcher's claim loop against fakes (`test-utils/mocks.ts`).
- `*.it-spec.ts` — **integration**, against a throwaway dockerized
  Postgres + Mongo (booted by `test-utils/global-setup.ts`, dynamic ports,
  tmpfs, migrations applied from scratch). This is where correctness lives:
  claim atomicity, epoch fencing, crash-resume without double-apply,
  same-claim races. **Never test these invariants with mocks** — their whole
  point is real SKIP LOCKED, real row locks, real commits.

Harnesses to reuse (don't hand-wire Nest contexts in specs):

- `apps/worker/test-utils/test-app.ts` — `getTestContext()`, `makeRunner()` /
  `makeInlineRunner()` (built through `RUNNER_FACTORY`, optionally with a
  substitute processor registry for poison rows / gated applies),
  `publishTask()`, `seedProducts()`, `rowAttempts()` (the no-double-apply
  witness).
- `apps/api/test-utils/test-app.ts` — boots the real HTTP app on port 0;
  exercise endpoints with `fetch`, not by calling controllers directly.
- Env tuning goes through `process.env` **before** the first
  `getTestContext()` call (config namespaces materialize at boot);
  `test-utils/.env.test` holds the stack-wide values — mind the boot guards
  (e.g. `RUNNER_CONCURRENCY` must fit `DB_MAX_CONNECTIONS`).

When adding a feature, mirror the existing pattern: name tests after the
guarantee they prove ("refuses a write once the epoch moved"), assert
structural evidence over logs (row `attempts`, ledger statuses, exact
counts), and cover the failure path with the same care as the happy path —
the one production bug found in review lived in the untested failure twin of
a well-tested success path.

## Sharp edges (learned the hard way)

- **Bun resolves `tsconfig.json` from the cwd without climbing.** Each app
  ships a `tsconfig.json` extending the root one; without it, running from a
  workspace dir silently drops parameter decorators and Nest DI breaks.
- **Drizzle's built-in `jsonb()` double-encodes on bun-sql** — use the custom
  `jsonbObject` type (`packages/database/drizzle/schema/jsonb-object.ts`).
- **postgres:18 images** moved PGDATA; volumes/tmpfs mount at
  `/var/lib/postgresql`, not `.../data`.
- A pg pool smaller than the process's concurrent queries wedges bun-sql
  under sustained load (frozen runner, heartbeat still beating). The boot
  guards exist because of this; don't remove them.
- The single migration is a deliberate squash (one-shot repo): after schema
  changes prefer regenerating on top; existing local DBs need
  `db:reset && db:migrate` if history is rewritten.
