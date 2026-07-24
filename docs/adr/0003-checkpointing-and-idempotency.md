# ADR 0003 — Checkpointing: a per-row ledger + idempotent effects

**Status:** accepted · *the heart of the design*

## Context

The runner can be `kill -9`'d mid-job (crash) or `SIGTERM`'d mid-job (deploy).
Re-firing it must resume **without double-applying rows** and reach a correct
final state.

Where the business data lives drives the whole design: co-located with the
task state (same Postgres), effect + checkpoint could commit atomically —
exactly-once even for non-idempotent effects. In an external store, the effect
and the checkpoint are separate commits, so the crash window between them is
real and must be made harmless by **idempotency** (re-applying converges). We
asked the reviewers which regime they expected:

> "An external store with idempotent effects: retries are safe because
> re-applying converges (works when the payload carries the absolute state,
> like a price)."

## Decision

**Postgres is infrastructure only**: `task` (the queue, ADR 0002) and
`task_row` (the checkpoint ledger). **MongoDB is the business store**:
`products` is the source of truth (one doc per product, `_id` = product id),
`catalogue_index` its per-catalogue search projection. Only the execution
paths connect to it.

Every NDJSON line is a durable row in `task_row` with its own `status`
(`pending | done | failed`). The runner applies a row in two separate commits,
**effect strictly first**:

1. the business effect — an idempotent write against the store (MongoDB);
2. the checkpoint — flip that `task_row` to `done` in Postgres.

A crash between the two leaves the row `pending`, so the effect is replayed —
and replaying converges. The reverse order would be broken: flip first and a
crash before the effect leaves a `done` row whose effect never happened, and
nothing would ever re-run it.

**Payloads carry absolute state, never deltas.** A price (`9.99`) re-applied
twice is still `9.99`; a delta (`-5`) re-applied twice is corruption. Both
kinds satisfy it naturally (a `$set` upsert; index docs under deterministic
`_id`s — see ADR 0005).

Resume is then trivial and stateless: on start the runner selects
`WHERE status = 'pending'` and processes whatever remains. There is **no cursor
to persist** and no "resume from row N" logic.

## Why this is correct

| Event | Outcome |
|-------|---------|
| `kill -9` after the effect, before the flip | Row stays `pending` → replayed → the idempotent effect converges (same `$set`, same `_id`). No corruption, no lost work. |
| `kill -9` after the flip | Row is `done`; the resume query never selects it again. No replay at all. |
| Two same-claim runners race a row | Both may apply the (idempotent, identical) effect; exactly one wins the `pending`-guarded flip, the loser skips the row. `attempts` stays 1. |

**Verified in the demo:** after a mid-job `kill -9` and resume, all rows are
`done`, the store holds exactly one doc per product, and **0 rows have
`attempts > 1`** — a structural proof that no row was applied twice.

## The mark-done guards

The `done` flip carries two guards: the epoch fence (ADR 0004) and a
`status = 'pending'` re-check. The fence handles a *reclaimed* task's zombie
runner; the re-check handles two runners holding the **same** claim (e.g. a
manual re-fire racing the dispatcher's still-live runner) — the loser blocks
on the row lock, re-checks `pending`, and misses. A missed flip is
disambiguated: epoch moved → the runner lost the whole task and stands down
without finalizing; epoch still held → only that row was settled by a
same-claim peer, so the runner skips it and keeps draining. Conflating the two
would let two racing runners both stand down, leaving a fully-processed task
unfinalized. The failure write (`recordRowFailure`) carries the same two
guards, for the same reasons — without them a fenced-out loser could resurrect
a row its peer already settled, or burn attempts it doesn't own.

`processed_rows` on the `task` is an advisory projection — it drives the
status endpoint and nothing else. It is advanced incrementally by each page's
committed rows (O(1) per page) and recomputed from the ledger at the run's
boundaries: once at start (healing any drift a crashed predecessor left) and
once at finalization (so the terminal value is exact).

## Bounded concurrency + graceful drain

Rows are processed with a bounded pool (`RUNNER_CONCURRENCY`). The pool checks a
`draining` flag **before starting** each row, never mid-flight, so SIGTERM lets
in-flight rows finish while starting no new work — the exact rolling-deploy
contract. A drain deadline (`RUNNER_DRAIN_TIMEOUT_MS`) bounds the wait: a row
stuck in an external call must not hold the process until the orchestrator
SIGKILLs it.

## Failure handling

A row that throws increments `attempts` and returns to `pending`; once it hits
`ROW_MAX_ATTEMPTS` it is dead-lettered to `failed` (surfaced and replayable —
ADR 0004). A task with any `failed` row finalizes as `failed`, otherwise
`completed`.

## Costs / trade-offs

- **A row per line.** Ingesting 50k rows is 50k inserts (batched). That's the
  price of per-row resumability; batching the effect would coarsen the
  checkpoint granularity.
- **Non-idempotent effects have no home.** A delta effect (`stock -= 5`, a
  charge, an email) cannot ride this design as-is: it would need a dedup guard
  (e.g. Mongo's single-document atomicity), a transactional outbox, or
  co-location with the ledger — the road not taken, confirmed by the
  reviewers' answer above.
- **The index can lag the store** between a price update's two writes if the
  process dies in between; the row replay repairs it, and the next re-index is
  a full catch-up either way.
