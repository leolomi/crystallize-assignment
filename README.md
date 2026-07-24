# Bulk task runner

A miniature of the production pattern: an **API**, a **queue**, a thin
**dispatcher**, and one-shot **runner** processes that execute large bulk jobs
off the request path — and, crucially, survive being killed mid-job.

## Quickstart

Prereqs: **Bun** and **Docker**.

```bash
bun install
bun run db:up          # postgres (:5432) + mongo (:27017) — the only infra
bun run db:migrate     # apply Drizzle migrations

bun run start          # api (http://localhost:3000) + dispatcher, together
```

Or each process in its own terminal: `bun run api` and `bun run dispatcher`.

Submit a job and watch it complete:

```bash
bun run seed 50000 job.ndjson                       # generate test NDJSON
curl -s -XPOST http://localhost:3000/tasks/product-price-updates \
  -H 'Content-Type: application/x-ndjson' \
  --data-binary @job.ndjson                          # -> { id, kind, status, totalRows }

curl -s http://localhost:3000/tasks/<id>             # live status + progress
```

A catalogue re-index has its own endpoint — a plain JSON POST:

```bash
curl -s -XPOST http://localhost:3000/tasks/catalogue-reindex \
  -H 'Content-Type: application/json' -d '{"catalogue":"products"}'
```

## The architecture

```
            POST /tasks (NDJSON)
                  │
                  ▼
          ┌───────────────┐  ingest rows, then publish
          │      API      │  (ingesting → pending)
          └───────┬───────┘
                  │  GET /tasks/:id
                  ▼
          ┌────────────────────┐   poll + atomic claim    ┌──────────────┐
          │      Postgres      │◀── (pending→starting, ── │  Dispatcher  │
          │  task = the queue  │    FOR UPDATE            │ (thin poller)│
          │  task_row = ledger │    SKIP LOCKED)          └──────┬───────┘
          └─────────▲──────────┘                                 │ spawn one-shot
                    │ checkpoint                                 ▼
                    │ (rows → done)                         ┌──────────────┐
                    └────────────────────────────────────── │    Runner    │
                                                            │ (one process │
          ┌─────────────────────────┐  idempotent upserts   │   per task)  │
          │         MongoDB         │◀────(bounded conc.)───└──────────────┘
          │ products = the store    │
          │ catalogue_index = index │
          └─────────────────────────┘
```

**Postgres is the queue, and only the queue**: the set of `pending` tasks is
the work queue, the dispatcher's atomic claim (`FOR UPDATE SKIP LOCKED`) is the
consume, and `task_row` is the checkpoint ledger. No broker — publishing a job
is just committing it (see ADR 0002). **Business data lives in MongoDB**
(`products` and its search projection `catalogue_index` — see ADR 0003); only
the execution paths touch it.

The dispatcher routes each claim by the task's **`weight`** (threshold
routing, ADR 0006): **heavy** tasks — big bulk jobs, and every re-index (long
by nature regardless of row count) — get a one-shot runner **process** of
their own, so a long job never blocks anything behind it; **light** tasks (at
or under `INLINE_THRESHOLD_ROWS`) run **inline** in the dispatcher, skipping
the process spawn. Each lane has its own cap, and the claim only asks for
weights with a free slot — a task the dispatcher cannot start stays `pending`.

## Why the split (the architectural bet)

- A bulk job is **too big for an HTTP request** and **too long for a queue
  consumer's visibility window**. So ownership of a job is a durable DB state,
  not a held message, and the work runs in a process whose lifetime is the
  job's lifetime.
- The dispatcher stays **thin and always-available**: claiming + spawning is
  O(milliseconds), so the queue never backs up behind one slow job.
- The runner is **disposable and resumable**. It owns no state the DB doesn't
  already hold, so killing it (crash or deploy) is a non-event.

See [`docs/adr`](docs/adr) for the decisions and their trade-offs, and
[`docs/architecture.excalidraw`](docs/architecture.excalidraw) for an editable
diagram of the full flow including recovery (open it at excalidraw.com).

## The heart: crash-safe checkpointing

The whole correctness story is two invariants:

> **The effect is applied before the row's `pending → done` flip — never
> after. And every effect is idempotent: re-applying converges.**

Each NDJSON line is a row in `task_row` (the checkpoint ledger). The runner
applies a row's effect against the business store (MongoDB), then flips the
row `done` in Postgres as a separate commit
([`row-executor.service.ts`](apps/worker/src/runner/services/row-executor.service.ts)).
The crash window between the two is real — and harmless:

- **Crash (`kill -9`) between effect and flip** → the row stays `pending` →
  the next run replays the effect. Every effect is an idempotent upsert of
  **absolute state** (a price, an index doc under a deterministic `_id`), so
  the replay converges instead of compounding (see ADR 0003). **No lost work,
  no corruption.**
- **A row that flipped** is `done`, and the resume query
  (`fetchPendingRows`) never selects it again → **no double-apply.**
- The reverse order would be broken: flip first and a crash before the effect
  leaves the row `done` with the effect never applied — and nothing would
  ever re-run it.

The runner doesn't know or care whether it's a first run or a resume — it just
drains whatever is still `pending`. Fired against a task no dispatcher has
claimed yet, it performs the **same atomic claim** the dispatcher would, so a
manual runner and the dispatcher can never both own a task. `processed_rows`
on the task is an **advisory projection** that powers `GET /tasks/:id`:
advanced by each page's committed rows (O(1) per page), recomputed from the
ledger at the run's boundaries; it is never the source of truth.

The mark-done flip carries two guards: the **epoch fence** (a reclaimed task's
old runner sees its writes miss) and a **`status = 'pending'` re-check**, so
even two runners racing the *same* claim flip each row exactly once — the
loser blocks on the row lock, re-checks, misses, and skips the row (both may
have applied the effect, which is exactly why effects must be idempotent). The
two misses mean different things: epoch moved → the runner stands down
entirely; epoch held → only that row was settled by a peer, so the loser
skips it and keeps draining (otherwise two racing runners would both stand
down and leave the task unfinalized).

## Layout

Bun workspaces: one app per process, shared code in packages. No build step —
Bun runs the sources, and cross-workspace imports (`@crystallize/*`) resolve
through the root tsconfig paths:

```
apps/api/             HTTP ingest (NDJSON envelopes -> publish) + status
apps/worker/          one deployable, two entrypoints (they always deployed
                      together — the spawn is by file path):
  src/dispatcher/     poll + claim + route (spawn heavy / inline light) + sweep
  src/runner/         one-shot runner main + the shared execution core
                      (per-kind processors, Mongo repositories, row executor)
packages/tasks/       THE shared contract: kinds, payloads + validators,
                      TaskRepository (claim SKIP LOCKED, resume query, checkpoint)
packages/database/    Drizzle schema (task state only) + migrations + wiring
packages/mongo/       Mongo connection wiring (config + generic client service)
packages/shared/      config utils (zod-validated @nestjs/config namespaces)
docker/               postgres (task state) + mongo (products + search index)
scripts/              NDJSON generator + the two failure-mode demos
```

Each entrypoint composes its own config (`load: [ownConfig, dbConfig, …]`) and
no app imports another app — the API is free-standing, and the dispatcher's
spawn seam (`RUNNER_ENTRYPOINT`) points at its own app's sibling entrypoint.
All root scripts (`bun run api|dispatcher|runner|db:*`) are unchanged.

## The two failure modes (reproducible demos)

Both scripts assume `api` + `dispatcher` are running.

```bash
bun run seed 50000 job.ndjson

./scripts/demo-crash.sh      # dispatcher spawns a runner; we kill -9 it mid-job,
                             # re-fire it, and assert: 50000 applied, 0 rows with
                             # attempts>1 (structural proof of no double-apply)

./scripts/demo-graceful.sh   # SIGTERM the runner mid-job; it drains in-flight
                             # rows, exits 0, stays resumable, then finishes
```

## API

| Method | Path                           | Body                    | Returns                                   |
|--------|--------------------------------|-------------------------|-------------------------------------------|
| POST   | `/tasks/product-price-updates` | NDJSON (`application/x-ndjson`), one `{id, price}` per line | `{ id, kind, status, totalRows }` |
| POST   | `/tasks/catalogue-reindex`     | JSON `{ catalogue }`    | `{ id, kind, status, totalRows }` |
| GET    | `/tasks/:id`                   | —                       | `{ kind, status, totalRows, processedRows, progress, ... }` |
| GET    | `/tasks/:id/dead-letters`      | — (`?limit&offset`)     | the task's `failed` rows, with error + attempts |
| POST   | `/tasks/:id/retry`             | —                       | replay a failed task (failed rows only) |

Interactive OpenAPI docs at **`/docs`** (`@nestjs/swagger`).

**One creation endpoint per kind**, each with its own body type (a zod schema
per endpoint — one task = one kind is structural, and NDJSON lines are bare
payloads, no `{type, payload}` envelope). The task resource itself stays
uniform: `GET /tasks/:id`, the claim and the resume don't care where a task
came from.

The bulk endpoint is NDJSON-only: lines are validated and inserted in batches
as they arrive (a typed AsyncGenerator), so a 50k-row job is never held whole
in memory.

```bash
printf '{"id":"prod-1","price":9.99}\n{"id":"prod-2","price":19.5}\n' | \
  curl -s -XPOST http://localhost:3000/tasks/product-price-updates \
    -H 'Content-Type: application/x-ndjson' --data-binary @-
```

The runner resolves a **processor per kind**, and every effect is an
**idempotent write against the business store** (see ADR 0003):
`product_price_update` upserts the product's price in the `products`
collection (absolute state — a crash-replay converges) and refreshes the
product's existing `catalogue_index` docs in place; `catalogue_reindex`
rebuilds `catalogue_index` from `products`, page by page (deterministic
`catalogue:productId` `_id`s make every page idempotent), and its page loop
checks the AbortSignal so SIGTERM interrupts it cleanly (see ADR 0005). The
price refresh never upserts the index — a product absent from it enters
through the next re-index, which knows its catalogue. Only the runner connects
to Mongo — the API and dispatcher have no reason to.

## Recovery: heartbeat, sweeper, dead letters

A runner proves liveness on a timer (`heartbeat_at`, every
`HEARTBEAT_INTERVAL_MS` — deliberately decoupled from row throughput so a long
external op doesn't read as dead). A **sweeper** in the dispatcher scans every
`SWEEP_INTERVAL_MS` for claims silent longer than `STALE_AFTER_MS` and flips
them back to `pending` in one atomic UPDATE — recovery IS re-publication: the
normal claim path re-fires the task, nothing else to do (see ADR 0004).

Each reclaim bumps the task's `epoch` (a fencing token): every runner write
carries `WHERE epoch = <mine>`, so a runner that was frozen — not dead — sees
its writes miss when it wakes up and stands down. Past `TASK_MAX_RESTARTS`
reclaims, the task is dead-lettered (`failed`) instead of re-pended, so a
poison job can't crash-loop. Tasks stuck `ingesting` (API died mid-stream) are
failed by the same sweep.

The **dead-letter queue is a status, not a queue**: rows that exhaust
`ROW_MAX_ATTEMPTS` sit in `status='failed'` with their error. Inspect them via
`GET /tasks/:id/dead-letters`; `POST /tasks/:id/retry` re-pends exactly those
rows (fresh attempts budget) and re-publishes the task — `done` rows are
untouched, so no-double-apply holds for replays too.

## Configuration

Typed `@nestjs/config` namespaces, zod-validated at boot (one config file per
app under `apps/*/src/config`, `db` in `packages/database`, `mongo` in
`packages/mongo`); every value has a localhost default, `.env` overrides (see
[`.env.example`](.env.example)).
Notable knobs: `DISPATCH_POLL_INTERVAL_MS` (queue poll cadence),
`DISPATCH_MAX_CONCURRENT_RUNNERS` (cap on live runner processes per
dispatcher — a burst of pending tasks doesn't fork a process per task; the
overflow stays `pending` for later ticks), `DISPATCH_MAX_CONCURRENT_INLINE` +
`INLINE_THRESHOLD_ROWS` (threshold routing: the light-lane cap, and the row
count at or under which the API publishes a bulk task as `light` — see ADR
0009), `RUNNER_CONCURRENCY` (in-flight
rows), `RUNNER_BATCH_SIZE` (rows pulled per page), `ROW_MAX_ATTEMPTS` (before
a row is dead-lettered), `ROW_RETRY_BACKOFF_MS` (pause before refetching a
page that recorded failures, so retries aren't burned in a hot loop),
`MONGO_HOST` / `MONGO_PORT` / `MONGO_DB` (the business store, runner-only),
`REINDEX_PAGE_SIZE` / `REINDEX_PAGE_DELAY_MS` (re-index paging + throttle —
the delay keeps the SIGTERM window comfortable in the demo),
`HEARTBEAT_INTERVAL_MS` / `STALE_AFTER_MS` / `SWEEP_INTERVAL_MS` /
`TASK_MAX_RESTARTS` (liveness and recovery; boot fails if the stale threshold
doesn't tolerate missed beats).

## Tests

```bash
bun test                  # unit tests (no infra)
bun run test:integration  # boots a throwaway dockerized Postgres + Mongo,
                          # migrates, and exercises the correctness core:
                          # atomic claim, epoch fence, resume without
                          # double-apply, idempotent replay convergence,
                          # same-claim runner race
```

## Scope

**Non-goals** (per the brief): auth, UI, realistic product modeling/validation,
multi-tenancy, IaC, Kubernetes manifests.

**Stretch goals — all three implemented, in the brief's order**: threshold
routing (`weight` light/heavy stamped at publish, light tasks run inline in
the dispatcher — ADR 0006), stale-runner detection (heartbeat + sweeper +
epoch fencing — ADR 0004), and the dead-letter path (inspect + replay
endpoints).
