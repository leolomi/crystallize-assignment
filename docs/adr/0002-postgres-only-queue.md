# ADR 0002 — Postgres is the queue (BullMQ removed)

**Status:** accepted

## Context

The first iteration used BullMQ/Redis to carry task ids from the API to the
dispatcher. Reviewing what it actually contributed exposed three facts:

1. **All truth already lives in Postgres** (required for crash-resume). The
   message was a pointer (`taskId`) fully re-derivable from the `task` table.
2. **Correctness never depended on the broker.** Uniqueness came from the
   conditional claim; loss-protection would have required an outbox/sweeper —
   i.e. a Postgres poll — anyway, at which point the broker only bought latency.
3. It left a real gap: the **dual-write** in POST /tasks (DB commit, then
   enqueue). A crash between the two produced a committed-but-never-dispatched
   task.

## Decision

Drop BullMQ and Redis. **The set of `pending` tasks is the queue**; the
dispatcher polls Postgres and consumes with an atomic claim:

```sql
UPDATE task SET status = 'starting', started_at = now()
 WHERE id = (SELECT id FROM task WHERE status = 'pending'
             ORDER BY created_at LIMIT 1
             FOR UPDATE SKIP LOCKED)
RETURNING id;
```

- `FOR UPDATE SKIP LOCKED` makes N concurrent dispatchers safe with zero
  coordination (each claims a different row) — the pg-boss/graphile-worker/oban
  model.
- A partial index on `status = 'pending'` (leading on `weight`, which the
  claim filters by — see ADR 0006) keeps the poll O(1) regardless of history.
- The poll runs every `DISPATCH_POLL_INTERVAL_MS` (default 1s) via
  `@nestjs/schedule`, with an immediate sweep at bootstrap to absorb any backlog
  accumulated while the dispatcher was down.

### The `ingesting` state

Polling introduced one race the enqueue model didn't have: the dispatcher could
claim a task while POST /tasks was still streaming rows in. Tasks are therefore
created `ingesting` (not claimable) and flipped to `pending` only after the last
row commits. **That flip is the publish** — there is no broker to notify, hence
no dual-write left anywhere in the system: a committed task is, by construction,
eventually dispatched.

## What we gained / lost

**Gained:** one infra service instead of two; the dual-write gap closed
structurally (not patched with a sweeper); delivery semantics reduced to one
visible SQL statement — easier to reason about, demo, and defend.

**Lost:** push latency (~ms → up to one poll interval; `LISTEN/NOTIFY` restores
push if it ever matters) and BullMQ's free machinery (delays, priorities, rate
limiting, backoff) — none of which this system uses.

## When we'd bring a broker back

Thousands of messages/sec where DB polling would contend; messages that are
*not* re-derivable from state (ephemeral business events with rich payloads);
need for delays/priorities/rate-limiting; or a hard requirement to isolate the
DB from queue traffic. None applies at this scale — and because the correctness
story never referenced the broker, reintroducing one later is a local change to
the API (publish) and dispatcher (consume) only.
