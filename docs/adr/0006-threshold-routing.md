# ADR 0006 — Threshold routing: light tasks inline, heavy tasks in a process

**Status:** accepted

## Context

The process-per-task split (ADR 0001) buys isolation for big jobs, but for a
tiny job — a 3-row price update — forking a process (and its DB connections)
is pure overhead. The brief's first stretch goal: "small jobs run inline in
the dispatcher; only large jobs spawn a runner."

## Decision

### `weight`, stamped at publish

Every task gets a `weight` (`light | heavy`), computed once by the API when it
publishes (`classifyWeight`, threshold `INLINE_THRESHOLD_ROWS`) and stored on
the task — so the routing of an already-queued task never changes under it,
and it is observable in `GET /tasks/:id`.

Classification is **kind-aware**, because row count is only a duration proxy
for row-shaped kinds: a catalogue re-index is ONE row but long by nature, so
it is heavy regardless of its row count. Only bulk price updates at or under
the threshold are light. Unstamped tasks default to `heavy` — the safe
fallback is a process of one's own, never inline.

### The claim only asks for what it can execute

`claimNextPending(weights)` filters by weight. Each tick the dispatcher
computes the lanes with free slots (`DISPATCH_MAX_CONCURRENT_RUNNERS` for
spawned runners, `DISPATCH_MAX_CONCURRENT_INLINE` for inline) and claims only
those weights — preserving the invariant that a task the dispatcher cannot
start right now stays `pending` instead of sitting claimed with no execution
behind it. A full heavy lane never blocks light tasks, and vice versa.

### The inline path reuses the runner, not a copy of it

The row-execution core (processors, Mongo repositories, executor) lives in a
shared `ExecutionModule`; `InlineRunner` builds a **fresh `RunnerService` per
light task** through the same container-owned factory — the one-shot process
in miniature, same claim fence, same heartbeat, same drain semantics
(including the drain deadline). One deliberate difference: inline runs use a
narrower row concurrency (`INLINE_ROW_CONCURRENCY`) than a dedicated process,
because every inline run shares the dispatcher's single pg pool — the
aggregate is checked against the pool size at boot.

Recovery needs nothing new: an inline task heartbeats like any other, so a
dispatcher that dies mid-inline-task is swept and the task re-pended (ADR
0004) — it may then be claimed by any lane.

## Trade-offs

- **The dispatcher now touches business data** (for light tasks): it carries
  the processor code and a Mongo connection. The connection is lazy, so a
  dispatcher that never sees a light task never opens it. The "only the
  runner does the heavy external work" boundary survives — re-indexes are
  heavy by construction.
- **A misclassified task wastes a lane**, not correctness: light/heavy only
  changes *where* the run happens, never the ledger semantics.
- **The threshold is an API-side knob**: changing it re-routes future
  publishes only. Deliberate — re-classifying pending tasks at claim time
  would make routing depend on which process claims.
