import { sql } from "drizzle-orm";
import {
  bigserial,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { TaskRowStatus } from "../../../tasks/src/types/task-row.enums";
import { tsEnumToPgEnum } from "../enum";
import { jsonbObject } from "./jsonb-object";
import { task } from "./task.schema";

export const taskRowStatusEnum = pgEnum(
  "task_row_status",
  tsEnumToPgEnum(TaskRowStatus),
);

/**
 * One ledger row per NDJSON line. This table IS the checkpoint: a row flips to
 * `done` inside the same transaction that applies its effect, so re-running a
 * task simply reprocesses whatever is still `pending`. Nothing is double-applied
 * (done rows are never re-selected) and nothing is lost (a killed transaction
 * rolls back, leaving the row `pending`).
 */
export const taskRow = pgTable(
  "task_row",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    taskId: uuid()
      .notNull()
      .references(() => task.id, { onDelete: "cascade" }),
    rowIndex: integer().notNull(),
    payload: jsonbObject().notNull(),
    status: taskRowStatusEnum().notNull().default(TaskRowStatus.PENDING),
    attempts: integer().notNull().default(0),
    error: text(),
    appliedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // Idempotent ingestion + a stable identity for each line.
    uniqueIndex("task_row_task_row_idx").on(t.taskId, t.rowIndex),
    // The runner's hot path: "next pending rows for this task". Partial so it
    // stays cheap once most rows are done.
    index("task_row_pending_idx")
      .on(t.taskId, t.rowIndex)
      .where(sql`${t.status} = 'pending'`),
    // The DLQ path: fetchFailedRows + retryFailed's re-pend, both
    // `task_id = ? and status = 'failed'`. Partial: failed rows are the
    // exception, so the index stays near-empty in the nominal regime.
    index("task_row_failed_idx")
      .on(t.taskId, t.rowIndex)
      .where(sql`${t.status} = 'failed'`),
    // The finalization counts (recomputeProgress / countRows): counting a
    // task's done rows via an index-only scan instead of walking the whole
    // ledger — the win is largest exactly when it matters, on the resume of
    // a big, mostly-settled task.
    index("task_row_done_idx").on(t.taskId).where(sql`${t.status} = 'done'`),
  ],
);
