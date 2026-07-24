# ADR 0004 — Recovery: heartbeat sweeper, epoch fencing, dead letters

**Status:** accepted

## Context

Crash-resume works (ADR 0003) but somebody has to notice that nobody is
working and re-fire the task. ADR 0002 established that all coordination state
lives in Postgres. Stale-runner detection and a dead-letter surface both
reduce to the same question: who notices, and what do they do about it?

## Decision

### Liveness is proven, not observed

A dead process tells no one. The runner therefore proves liveness on its own
timer (`HEARTBEAT_INTERVAL_MS`), stamping `heartbeat_at` — deliberately
decoupled from row throughput, so a minutes-long external op (the re-index)
doesn't read as dead. The *absence* of beats is the signal. All staleness is
judged against the server's `now()`, so client clock skew never enters it.

The known limit of this design: the heartbeat proves the **process** is alive,
not that it makes **progress**. A run wedged in an unbounded external call
beats forever and is never reclaimed — which is why every external operation
carries its own timeout (Mongo `timeoutMS`) and the drain has a deadline: a
wedged op must become a plain row failure, owned by the retry machinery.

### Recovery is re-publication

A sweeper tick in the dispatcher (the always-on process — no fourth process)
runs one atomic UPDATE: claimed tasks (`starting`/`running`) silent longer than
`STALE_AFTER_MS` go back to `pending` — clearing the dead runner's last beat,
so the re-claim's fresh `started_at` is what the next staleness check sees.
That's the whole recovery: the normal claim/spawn/resume path does the rest.
The sweeper never spawns or repairs anything, and concurrent sweepers are safe
for the same reason concurrent claimers are (row lock + WHERE re-check). Tasks
stuck `ingesting` (API died mid-stream) are failed by the same sweep — they
are never claimable, so the reclaim can't see them.

### Silence proves silence, not death — epoch fencing

A frozen runner (GC pause, network partition) can wake after its task was
reclaimed, giving two live runners on one task. Each reclaim bumps `task.epoch`
and every runner write is fenced (`WHERE epoch = <mine>`; row flips check the
owning task's epoch, so a fenced-out mark-done misses). The first missed write
tells the zombie to stand down without finalizing. This is the classic
fencing-token answer. Note what the fence does NOT do: the effect the zombie
may already have applied lives in MongoDB, outside any Postgres transaction,
and is never rolled back — it stands, and idempotency (ADR 0003) is what makes
that harmless.

### Dead letters are a status, not a queue

Per ADR 0002 there is no broker to move poison messages to. Rows that exhaust
`ROW_MAX_ATTEMPTS` already sit in `task_row.status = 'failed'` with their
error; tasks that exhaust `TASK_MAX_RESTARTS` reclaims are failed rather than
re-pended (a poison job must not crash-loop). The surface:
`GET /tasks/:id/dead-letters` (inspect) and `POST /tasks/:id/retry`
(replay: failed rows back to `pending` with a fresh budget, task re-published,
epoch bumped — `done` rows untouched, so no-double-apply holds for replays).

## Consequences

- Unattended crash recovery: the crash demo needs no manual re-fire; the task
  completes with `attempts > 1 = 0` (verified on a 100k-row job).
- Two columns (`restarts`, `epoch`), one partial index on active tasks.
- `STALE_AFTER_MS` must tolerate missed beats — config refuses to boot unless
  it is ≥ 3× `HEARTBEAT_INTERVAL_MS`.
- The retry endpoint is also the user-facing recovery for sweeper-dead-lettered
  tasks; a task that failed *during ingestion* is not replayable (never fully
  stored) and must be resubmitted.
