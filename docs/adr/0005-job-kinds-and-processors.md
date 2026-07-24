# ADR 0005 — Job kinds: one endpoint per kind, a processor registry

**Status:** accepted

## Context

The brief describes two shapes of bulk work, structurally different:

|                | product price update        | catalogue re-index                 |
|----------------|-----------------------------|------------------------------------|
| rows           | many (one per product)      | one (the whole operation)          |
| unit of work   | small, fast                 | single, long, heavy                |
| idempotency    | `$set` of absolute state    | intrinsic (rebuild converges)      |

Both must flow through the same API, queue, dispatcher, and runner without
special-casing in the core loop.

## Decision

### One creation endpoint per kind

Each kind has its own creation endpoint with its own body type:
`POST /tasks/product-price-updates` streams NDJSON, one bare `{id, price}`
payload per line; `POST /tasks/catalogue-reindex` takes a plain JSON body that
IS the single payload. One task = one kind is **structural**: the endpoint
determines the kind, so no request can violate it — no `type` discriminator to
validate, no mixed-kind rejection path. The task resource itself stays uniform
(`GET /tasks/:id`, dead-letters, retry): the queue, the claim, and the resume
don't care where a task came from.

An enveloped single endpoint (`POST /tasks` with `{"type", "payload"}` lines)
was considered and dropped: the discriminator buys per-row kind routing we
explicitly don't want (one task = one kind is the claim/resume unit), at the
cost of a runtime homogeneity check and weaker typing per body.

### A processor per kind in the runner

The runner resolves a **`RowProcessor`** from a registry using `task.kind`.
Its loop (fetch pending → bounded-concurrency map → checkpoint → finalize) is
kind-agnostic; only the per-row effect is pluggable. Every processor is an
**idempotent write against the business store** (the regime of ADR 0003):

- `product_price_update` — two writes, source before projection: `$set`
  upsert of the price on `products`, then an in-place refresh of the
  product's existing `catalogue_index` docs. The refresh deliberately never
  upserts: a product absent from the index enters it through the next
  re-index, which knows which catalogue(s) it belongs to. The ordering is the
  correctness argument — a crash between the two leaves the row `pending`, so
  both (idempotent) writes are replayed.
- `catalogue_reindex` — one row that rebuilds `catalogue_index` from
  `products`, page by page (keyset over `_id`); every doc an upsert under a
  deterministic `_id` (`catalogue:productId`), so a replay converges on the
  same index instead of appending.

### Long-op graceful shutdown

External effects can be long. Processors receive an `AbortSignal` that fires
on SIGTERM; the re-index checks it between pages (and its inter-page throttle
is an interruptible sleep), so a rolling deploy cuts it short and leaves its
single row `pending` for the next runner — no failed attempt, no corruption.

## Trade-offs

- **One row per re-index means coarse resumability.** A crash re-runs the
  whole re-index rather than resuming partway. Acceptable because it is
  idempotent; if partial resume mattered, the refinement is to chunk it into
  many rows — same ledger model, finer grain.
- **One kind per task** keeps claim/resume/progress semantics trivial (a
  task's processor is resolved once). Adding a kind is a new endpoint + a new
  processor; per-row kind routing would need an envelope format — deliberately
  out of scope.
