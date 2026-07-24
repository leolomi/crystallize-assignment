/**
 * The row-ledger enum — single source of truth for both the pg enum (the
 * Drizzle schema builds it via `tsEnumToPgEnum`, importing THIS file
 * directly) and every TS-side check.
 *
 * Keep this file a leaf (no imports): the database package reaches into it
 * from the schema, so any import here could turn into a package cycle at
 * module-initialization time.
 */

/**
 * A ledger row's state: `pending` awaiting work, `done` applied (the
 * checkpoint flip, committed after its idempotent effect — ADR 0003),
 * `failed` dead-lettered after exhausting its attempts.
 */
export enum TaskRowStatus {
  PENDING = "pending",
  DONE = "done",
  FAILED = "failed",
}
