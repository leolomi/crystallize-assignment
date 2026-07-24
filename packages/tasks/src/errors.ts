/**
 * Thrown by a runner when one of its epoch-fenced writes misses: the sweeper
 * reclaimed the task (bumping `epoch`) while this runner was still alive but
 * silent. The runner must stand down without finalizing — a newer runner owns
 * the task now. The effect it may already have applied (MongoDB, outside any
 * Postgres transaction) stands; idempotency makes the new owner's replay
 * converge (ADR 0003).
 */
export class StaleRunnerError extends Error {
  constructor(taskId: string) {
    super(`Lost ownership of task ${taskId}: epoch advanced by the sweeper`);
    this.name = "StaleRunnerError";
  }
}

/**
 * Thrown by a runner when a row's mark-done misses while the epoch still
 * holds: a concurrent runner of the SAME claim already settled this row. Not
 * a lost task and not a row failure — both runners may have applied the
 * (idempotent, identical) effect, the peer's flip stands, so this runner
 * skips the row and keeps draining. Losing the task itself is
 * `StaleRunnerError`; the distinction matters because treating a row
 * collision as a lost task would make two racing runners BOTH stand down,
 * leaving the task unfinalized.
 */
export class RowSupersededError extends Error {
  constructor(taskId: string, rowId: number) {
    super(`Row ${rowId} of task ${taskId} was settled by a concurrent runner`);
    this.name = "RowSupersededError";
  }
}
