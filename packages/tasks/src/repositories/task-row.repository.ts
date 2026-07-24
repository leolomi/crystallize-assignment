import {
  DRIZZLE_DATABASE_PROVIDER,
  type DrizzleDatabaseProvider,
  schema,
} from "@crystallize/database";
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, exists, lt, sql } from "drizzle-orm";
import type { TaskOwner } from "../types/task.types";
import { TaskRowStatus } from "../types/task-row.enums";
import type {
  DeadLetterRow,
  PendingRow,
  RowCounts,
} from "../types/task-row.types";

const { task, taskRow } = schema;

/**
 * The ledger side of persistence: everything that reads or writes `task_row`.
 * `fetchPendingRows` is the resume query and `markRowDone` the checkpoint flip
 * — together they carry the no-lost-work / no-double-apply guarantee. Task
 * lifecycle (claim, fences, sweeps) lives in TaskRepository.
 */
@Injectable()
export class TaskRowRepository {
  constructor(
    @Inject(DRIZZLE_DATABASE_PROVIDER)
    private readonly db: DrizzleDatabaseProvider,
  ) {}

  /**
   * Batch-insert ingested rows. Called repeatedly while streaming the body.
   * Also touches the task's updated_at so a stalled ingestion (API death
   * mid-stream) is distinguishable from one that is still making progress.
   */
  async addRows(
    taskId: string,
    rows: { rowIndex: number; payload: Record<string, unknown> }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(taskRow).values(
      rows.map((r) => ({
        taskId,
        rowIndex: r.rowIndex,
        payload: r.payload,
      })),
    );
    await this.db
      .update(task)
      .set({ updatedAt: sql`now()` })
      .where(eq(task.id, taskId));
  }

  /**
   * The resume query. Returns the next slice of rows still needing work,
   * skipping done rows and dead-lettered ones (attempts exhausted). Because
   * rows flip to `done` in their own transaction, re-running picks up exactly
   * where the last run stopped — no cursor to persist.
   */
  async fetchPendingRows(
    taskId: string,
    maxAttempts: number,
    limit: number,
  ): Promise<PendingRow[]> {
    return this.db
      .select({
        id: taskRow.id,
        rowIndex: taskRow.rowIndex,
        payload: taskRow.payload,
      })
      .from(taskRow)
      .where(
        and(
          eq(taskRow.taskId, taskId),
          eq(taskRow.status, TaskRowStatus.PENDING),
          lt(taskRow.attempts, maxAttempts),
        ),
      )
      .orderBy(asc(taskRow.rowIndex))
      .limit(limit);
  }

  /**
   * Mark a row done — the checkpoint flip, committed separately from the
   * (idempotent) effect the processor already applied.
   *
   * Two guards, and the row must pass both:
   *
   *   - epoch fence via the owning task: the sweeper reclaimed the task, so
   *     this runner no longer owns it;
   *   - `status = 'pending'`: the row was already done. The epoch fence alone
   *     cannot catch a concurrent runner holding the SAME epoch (e.g. a manual
   *     re-fire racing the dispatcher's runner), and it is evaluated as an
   *     unlocked read — a reclaim can land between that read and our commit.
   *     Under either race the second writer blocks on the row lock, re-checks
   *     `pending` after the first commit, and misses.
   *
   * Returns false when a guard misses — the caller then skips the row or
   * stands down (see RowExecutor).
   */
  async markRowDone(rowId: number, owner: TaskOwner): Promise<boolean> {
    const updated = await this.db
      .update(taskRow)
      .set({
        status: TaskRowStatus.DONE,
        appliedAt: sql`now()`,
        attempts: sql`${taskRow.attempts} + 1`,
        error: null,
      })
      .where(
        and(
          eq(taskRow.id, rowId),
          eq(taskRow.status, TaskRowStatus.PENDING),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(task)
              .where(
                and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)),
              ),
          ),
        ),
      )
      .returning({ id: taskRow.id });
    return updated.length > 0;
  }

  /**
   * Record a row failure; dead-letter it once it exhausts its attempts.
   *
   * Same two guards as `markRowDone`, for the same reasons: without them a
   * fenced-out zombie (or the loser of a same-claim race) whose effect threw
   * could resurrect a row a peer already settled — flipping it back to
   * `pending` under a finalized task, or burning attempts it doesn't own
   * until the row (then the whole task) is dead-lettered with every effect
   * actually applied.
   *
   * Returns false when a guard misses — the caller then skips the row or
   * stands down (see RunnerService.drainRows).
   */
  async recordRowFailure(
    rowId: number,
    owner: TaskOwner,
    error: string,
    maxAttempts: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(taskRow)
      .set({
        attempts: sql`${taskRow.attempts} + 1`,
        error,
        status: sql`(case when ${taskRow.attempts} + 1 >= ${maxAttempts} then ${TaskRowStatus.FAILED} else ${TaskRowStatus.PENDING} end)::task_row_status`,
      })
      .where(
        and(
          eq(taskRow.id, rowId),
          eq(taskRow.status, TaskRowStatus.PENDING),
          exists(
            this.db
              .select({ one: sql`1` })
              .from(task)
              .where(
                and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)),
              ),
          ),
        ),
      )
      .returning({ id: taskRow.id });
    return updated.length > 0;
  }

  async countRows(taskId: string): Promise<RowCounts> {
    const [c] = await this.db
      .select({
        total: sql<number>`count(*)::int`,
        done: sql<number>`count(*) filter (where ${taskRow.status} = ${TaskRowStatus.DONE})::int`,
        failed: sql<number>`count(*) filter (where ${taskRow.status} = ${TaskRowStatus.FAILED})::int`,
        pending: sql<number>`count(*) filter (where ${taskRow.status} = ${TaskRowStatus.PENDING})::int`,
      })
      .from(taskRow)
      .where(eq(taskRow.taskId, taskId));
    return c;
  }

  /** The DLQ is a status, not a queue: these are the task's `failed` rows. */
  async fetchFailedRows(
    taskId: string,
    limit: number,
    offset: number,
  ): Promise<DeadLetterRow[]> {
    return this.db
      .select({
        rowIndex: taskRow.rowIndex,
        payload: taskRow.payload,
        error: taskRow.error,
        attempts: taskRow.attempts,
      })
      .from(taskRow)
      .where(
        and(
          eq(taskRow.taskId, taskId),
          eq(taskRow.status, TaskRowStatus.FAILED),
        ),
      )
      .orderBy(asc(taskRow.rowIndex))
      .limit(limit)
      .offset(offset);
  }
}
