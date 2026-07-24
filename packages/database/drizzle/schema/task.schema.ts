import { sql } from "drizzle-orm";
import {
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// Relative import into the tasks package ON PURPOSE: the
// domain enums are the source of truth, and this schema must stay resolvable
// by drizzle-kit (which runs from packages/database, without the root
// tsconfig paths). The target is a leaf module, so no package cycle can form.
import {
  TaskKind,
  TaskStatus,
  TaskWeight,
} from "../../../tasks/src/types/task.enums";
import { tsEnumToPgEnum } from "../enum";

export const taskStatusEnum = pgEnum("task_status", tsEnumToPgEnum(TaskStatus));

export const taskKindEnum = pgEnum("task_kind", tsEnumToPgEnum(TaskKind));

export const taskWeightEnum = pgEnum("task_weight", tsEnumToPgEnum(TaskWeight));

/**
 * A bulk job — and, together with the claim, the queue itself: the set of
 * `pending` tasks IS the work queue, and the dispatcher's atomic claim
 * (`pending -> starting` with FOR UPDATE SKIP LOCKED) is the consume/ack.
 *
 * Lifecycle: `ingesting` while POST /tasks streams rows in (not claimable —
 * prevents the dispatcher from racing a half-ingested job), `pending` once the
 * job is complete and visible, `starting` when claimed, `running` under a
 * runner, then `completed`/`failed`.
 *
 * `processedRows` is an advisory, recomputable projection (COUNT of done rows)
 * that powers GET /tasks/:id — it is NOT the source of truth for progress. The
 * real checkpoint is each row's own status in `task_row`.
 */
export const task = pgTable(
  "task",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: taskKindEnum().notNull().default(TaskKind.PRODUCT_PRICE_UPDATE),
    status: taskStatusEnum().notNull().default(TaskStatus.INGESTING),
    // Threshold routing (ADR 0006): set at publish by classifyWeight. Heavy by
    // default — the safe fallback is a process of one's own, never inline.
    weight: taskWeightEnum().notNull().default(TaskWeight.HEAVY),
    totalRows: integer().notNull().default(0),
    processedRows: integer().notNull().default(0),
    error: text(),
    runnerPid: integer(),
    // timestamptz everywhere: staleness compares these to the server's now(),
    // so the column must carry an unambiguous instant, not a local wall time.
    heartbeatAt: timestamp({ withTimezone: true }),
    // How many times the sweeper reclaimed this task after a silent runner
    // death; past the budget it dead-letters the task instead of re-pending.
    restarts: integer().notNull().default(0),
    // Fencing token: bumped on every sweeper reclaim (and DLQ retry). Runner
    // writes carry `where epoch = <mine>`, so a zombie that wakes up after its
    // task was reclaimed sees its writes miss and stands down.
    epoch: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    updatedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // The dispatcher's hot path: "oldest pending task among the weights with a
    // free lane". `weight` leads so the claim's `weight in (...)` filter is
    // resolved in the index, not post-scan; partial keeps the poll O(1)
    // regardless of how much history accumulates.
    index("task_pending_idx")
      .on(t.weight, t.createdAt)
      .where(sql`${t.status} = 'pending'`),
    // The sweeper's hot path: "claimed tasks whose heartbeat went silent".
    // Partial so it scales with the number of active tasks, not with history.
    index("task_active_idx")
      .on(t.heartbeatAt)
      .where(sql`${t.status} in ('starting', 'running')`),
  ],
);
