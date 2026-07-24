# Architecture decision records

One record per decision, in reading order — each builds on the previous:

| ADR | Decision |
|-----|----------|
| [0001](0001-process-split.md) | API / dispatcher / runner as separate processes |
| [0002](0002-postgres-only-queue.md) | Postgres is the queue (BullMQ removed) |
| [0003](0003-checkpointing-and-idempotency.md) | Per-row ledger + idempotent effects — *the heart of the design* |
| [0004](0004-recovery-heartbeat-sweeper-dead-letters.md) | Recovery: heartbeat, sweeper, epoch fencing, dead letters |
| [0005](0005-job-kinds-and-processors.md) | One endpoint per kind, a processor registry |
| [0006](0006-threshold-routing.md) | Threshold routing: light inline, heavy in a process |
| [0007](0007-stack-choices.md) | Stack: Bun, Drizzle, NestJS, workspaces |

The load-bearing chain for correctness is **0002 → 0003 → 0004**: the claim,
the ledger + idempotency regime, and the recovery that rests on both.
