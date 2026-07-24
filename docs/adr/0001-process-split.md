# ADR 0001 — API / dispatcher / runner as separate processes

**Status:** accepted

## Context

Users trigger bulk operations ("update the price of these 50,000 products").
Such a job is too big to run inside an HTTP request and too long to run inside a
queue consumer's visibility window. A long job must not block anything behind it.

## Decision

Split responsibilities across process types, one shared codebase (two
deployables: `apps/api`, and `apps/worker` with two entrypoints — dispatcher
and runner always deploy together, the spawn is by file path):

- **API** — records the job (`task` + `task_row` rows) and publishes it
  (`ingesting → pending`), serves status. Never processes rows.
- **Dispatcher** — a thin, long-running queue consumer (Postgres poll, ADR
  0002). Atomically claims a task (`pending → starting`, FOR UPDATE SKIP
  LOCKED) and routes it by weight (ADR 0006): heavy tasks get a runner as a
  **separate OS process**, light tasks run inline. Also hosts the recovery
  sweeper (ADR 0004).
- **Runner** — a one-shot process, one per heavy task. Drains the task's rows
  with bounded concurrency, checkpoints, finalizes, exits.

## What the split buys

- **Isolation of blast radius.** Each large job runs in its own process with its
  own lifetime. A slow or crashing job can't stall the dispatcher or starve other
  jobs — the dispatcher is free again in milliseconds.
- **The visibility-window problem disappears.** The claim + spawn takes
  milliseconds, so a 10-minute job never lives inside a consumer's delivery
  window — the task's ownership is a durable DB state (`starting`/`running`),
  not a held message.
- **Deploys are cheap.** The runner is disposable; rolling a deploy is just
  SIGTERM → drain → a fresh runner resumes (see ADR 0003).
- **Independent scaling.** Runners scale with job volume; the dispatcher stays a
  single cheap consumer.

## What it costs

- **More moving parts.** Three entrypoints, a spawn boundary, and a claim
  protocol instead of one consumer that does the work inline.
- **Orphan-recovery is our job.** Because the dispatcher's involvement ends at
  spawn, a silently-dead runner leaves a task `running` that nothing would
  reclaim — hence the heartbeat + sweeper (ADR 0004).
- **Spawn cost.** One process per task is pure overhead for tiny jobs — hence
  threshold routing (ADR 0006): small jobs run inline in the dispatcher.
- **A connection budget.** Every process carries its own pg pool, so the
  aggregate (api + dispatchers + concurrent runners) must fit Postgres's
  `max_connections` — the caps and pool sizes are sized together and checked
  at boot (see the config comments in `dispatch.config.ts`).

## Alternatives considered

- **Single consumer processes rows inline** — simplest, but one long job blocks
  the consumer and blows the visibility window; rejected as the core anti-pattern
  the brief calls out.
- **Runner as a thread/worker inside the dispatcher** — shares a process, so a
  crash takes the dispatcher with it and deploys can't drain one job
  independently. A thread has no independent PID to kill; the process boundary
  is exactly what lets a runner be killed / crash / deploy on its own.

The spawn boundary here stands in for a Kubernetes Job / ECS task in production;
locally it's `Bun.spawn` of the runner entrypoint (a real OS process — its
`onExit` hook also gives the dispatcher free observability of runner outcomes).
