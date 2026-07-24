import {
  DRIZZLE_DATABASE_PROVIDER,
  type DrizzleDatabaseProvider,
  schema,
} from "@crystallize/database";
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { TaskStatus, TaskWeight } from "../types/task.enums";
import type {
  ClaimedTask,
  RetryOutcome,
  TaskKind,
  TaskOwner,
  TaskRecord,
} from "../types/task.types";
import { TaskRowStatus } from "../types/task-row.enums";

const { task, taskRow } = schema;

/** The Drizzle row shape for `task` — never leaves this file; `toTask` maps it out. */
type TaskRow = typeof schema.task.$inferSelect;

/**
 * The single ORM -> domain boundary: project a Drizzle `task` row onto the
 * hand-written domain `TaskRecord`. Explicit field-by-field on purpose — if a
 * column and the domain type drift apart, this stops compiling here rather than
 * leaking the schema shape to consumers.
 */
function toTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    weight: row.weight,
    totalRows: row.totalRows,
    processedRows: row.processedRows,
    error: row.error,
    runnerPid: row.runnerPid,
    heartbeatAt: row.heartbeatAt,
    restarts: row.restarts,
    epoch: row.epoch,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Task-lifecycle persistence: the `task` table only. The methods that carry
 * the correctness story are `claim` (atomic pending -> starting) and the
 * epoch-fenced runner writes (a reclaimed task's old runner sees its writes
 * miss). Everything else is bookkeeping. The row ledger (resume query,
 * checkpoint flip, dead-letter inspection) lives in TaskRowRepository.
 */
@Injectable()
export class TaskRepository {
  constructor(
    @Inject(DRIZZLE_DATABASE_PROVIDER)
    private readonly db: DrizzleDatabaseProvider,
  ) {}

  async createTask(kind: TaskKind): Promise<string> {
    const [row] = await this.db
      .insert(task)
      .values({ kind, status: TaskStatus.INGESTING })
      .returning({ id: task.id });
    return row.id;
  }

  async setTotalRows(taskId: string, total: number): Promise<void> {
    await this.db
      .update(task)
      .set({ totalRows: total, updatedAt: sql`now()` })
      .where(eq(task.id, taskId));
  }

  /**
   * Publish: flip `ingesting -> pending` once every row is committed, stamping
   * the routing weight (see classifyWeight). Only now does the task become
   * visible to the dispatcher's claim — this ordering is what prevents a
   * runner from racing a half-ingested job. The INSERT+flip is the whole
   * "enqueue": there is no separate broker to notify.
   */
  async markPending(taskId: string, weight: TaskWeight): Promise<void> {
    await this.db
      .update(task)
      .set({ status: TaskStatus.PENDING, weight, updatedAt: sql`now()` })
      .where(and(eq(task.id, taskId), eq(task.status, TaskStatus.INGESTING)));
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    const row = await this.db.query.task.findFirst({
      where: eq(task.id, taskId),
    });
    return row ? toTask(row) : null;
  }

  /**
   * The queue's "consume": atomically claim the oldest pending task
   * (pending -> starting) among the given weights, or null when nothing
   * claimable remains. The weight filter is the threshold-routing half of the
   * claim: the dispatcher only asks for weights it can execute right now, so
   * a task it cannot start stays `pending` instead of sitting claimed with no
   * execution behind it.
   *
   * FOR UPDATE SKIP LOCKED makes concurrent dispatchers safe without
   * coordination: two pollers can never claim the same task — one locks the
   * row, the other skips it and takes the next. This single statement is the
   * entire delivery guarantee; there is no broker state to reconcile with.
   */
  async claimNextPending(weights: TaskWeight[]): Promise<ClaimedTask | null> {
    if (weights.length === 0) return null;
    const oldestClaimable = this.db
      .select({ id: task.id })
      .from(task)
      .where(
        and(eq(task.status, TaskStatus.PENDING), inArray(task.weight, weights)),
      )
      .orderBy(task.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    const [claimed] = await this.db
      .update(task)
      .set({
        status: TaskStatus.STARTING,
        startedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(inArray(task.id, oldestClaimable))
      .returning({ id: task.id, weight: task.weight });
    return claimed ?? null;
  }

  /**
   * The runner's own claim, for a task fired by hand (`bun run runner <id>`)
   * that no dispatcher has claimed yet. Same atomic flip as `claimNextPending`
   * but for a specific id: exactly one of a manual runner and the dispatcher
   * wins the `pending -> starting` transition; the loser sees null and exits.
   * Returns the task's epoch (the fence every subsequent write carries).
   */
  async claimPending(taskId: string): Promise<number | null> {
    const [claimed] = await this.db
      .update(task)
      .set({
        status: TaskStatus.STARTING,
        startedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(task.id, taskId), eq(task.status, TaskStatus.PENDING)))
      .returning({ epoch: task.epoch });
    return claimed?.epoch ?? null;
  }

  /**
   * Runner announces it owns the task. Epoch-fenced like every runner write:
   * returns false when the claim no longer holds (sweeper reclaimed it).
   */
  async markRunning(owner: TaskOwner, pid: number): Promise<boolean> {
    const updated = await this.db
      .update(task)
      .set({
        status: TaskStatus.RUNNING,
        runnerPid: pid,
        // Server clock, like every heartbeat write: staleness is judged
        // against the server's now(), so client clock skew must not enter it.
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)))
      .returning({ id: task.id });
    return updated.length > 0;
  }

  /**
   * The liveness proof (the timer policy lives in RunnerService.startHeartbeat).
   * Returns false when ownership was lost.
   */
  async heartbeat(owner: TaskOwner): Promise<boolean> {
    const updated = await this.db
      .update(task)
      .set({ heartbeatAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)))
      .returning({ id: task.id });
    return updated.length > 0;
  }

  /**
   * Read-only fence check: does this owner's epoch still hold? Used to
   * disambiguate a missed `markRowDone`: epoch gone -> the task was reclaimed
   * (stand down); epoch held -> only that row was settled by a same-claim
   * peer (skip it, keep draining).
   */
  async ownershipHolds(owner: TaskOwner): Promise<boolean> {
    const rows = await this.db
      .select({ id: task.id })
      .from(task)
      .where(and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)));
    return rows.length > 0;
  }

  /**
   * Advisory per-page progress checkpoint + heartbeat: bump processed_rows by
   * the rows this page committed. O(1) per page — the full COUNT lives in
   * `recomputeProgress`, run once at the run's boundaries, so a 50k-row task
   * costs one scan, not one per page. The real checkpoint is the per-row
   * status. Returns false when ownership was lost.
   */
  async advanceProgress(owner: TaskOwner, delta: number): Promise<boolean> {
    const updated = await this.db
      .update(task)
      .set({
        processedRows: sql`${task.processedRows} + ${delta}`,
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)))
      .returning({ id: task.id });
    return updated.length > 0;
  }

  /**
   * Recompute processed_rows from the ledger (the source of truth). Run at the
   * start of a run — healing any drift a crashed predecessor left between its
   * last committed rows and its last checkpoint — and at finalization, so the
   * terminal value is exact. Returns the count, or null when ownership was
   * lost.
   */
  async recomputeProgress(owner: TaskOwner): Promise<number | null> {
    const updated = await this.db
      .update(task)
      .set({
        processedRows: sql`(select count(*)::int from ${taskRow} where ${taskRow.taskId} = ${owner.taskId} and ${taskRow.status} = ${TaskRowStatus.DONE})`,
        heartbeatAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)))
      .returning({ processedRows: task.processedRows });
    return updated[0]?.processedRows ?? null;
  }

  /** Runner finalization, epoch-fenced. Returns false when ownership was lost. */
  async markCompleted(owner: TaskOwner): Promise<boolean> {
    const updated = await this.db
      .update(task)
      .set({
        status: TaskStatus.COMPLETED,
        finishedAt: sql`now()`,
        error: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(task.id, owner.taskId), eq(task.epoch, owner.epoch)))
      .returning({ id: task.id });
    return updated.length > 0;
  }

  /**
   * Mark a task failed. Unfenced (`epoch` optional): the API's ingestion
   * failure path and the sweeper own no epoch.
   */
  async markFailed(
    taskId: string,
    error: string,
    epoch?: number,
  ): Promise<boolean> {
    const updated = await this.db
      .update(task)
      .set({
        status: TaskStatus.FAILED,
        finishedAt: sql`now()`,
        error,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(task.id, taskId),
          ...(epoch === undefined ? [] : [eq(task.epoch, epoch)]),
        ),
      )
      .returning({ id: task.id });
    return updated.length > 0;
  }

  // ── Sweeper ──────────────────────────────────────────────────────────────

  /**
   * Recover silently-dead runners: any claimed task (`starting`/`running`)
   * whose heartbeat went silent for `staleAfterMs` goes back to `pending`, so
   * the NORMAL claim path re-fires it — the sweeper never spawns anything.
   * Bumping `epoch` fences out the old runner if it was only frozen, not dead.
   * Concurrent sweepers are safe: the row lock + WHERE re-check make this a
   * claim in reverse.
   */
  async reclaimStale(
    staleAfterMs: number,
    maxRestarts: number,
  ): Promise<string[]> {
    const reclaimed = await this.db
      .update(task)
      .set({
        status: TaskStatus.PENDING,
        runnerPid: null,
        // Clear the dead runner's last beat: staleness falls back to
        // `started_at`, which the next claim stamps fresh. Leaving the stale
        // beat behind would let a sweep tick fire inside the next runner's
        // boot window and re-reclaim it — burning the restart budget on a
        // task that stalled only once.
        heartbeatAt: null,
        restarts: sql`${task.restarts} + 1`,
        epoch: sql`${task.epoch} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          inArray(task.status, [TaskStatus.STARTING, TaskStatus.RUNNING]),
          this.heartbeatSilentFor(staleAfterMs),
          lt(task.restarts, maxRestarts),
        ),
      )
      .returning({ id: task.id });
    return reclaimed.map((r) => r.id);
  }

  /**
   * The task-level dead-letter: a stale task that already burned its restart
   * budget is failed, not re-pended — this is what stops a poison job (runner
   * OOMs every time) from crash-looping forever.
   */
  async deadLetterStale(
    staleAfterMs: number,
    maxRestarts: number,
  ): Promise<string[]> {
    const deadLettered = await this.db
      .update(task)
      .set({
        status: TaskStatus.FAILED,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
        epoch: sql`${task.epoch} + 1`,
        error: sql`'stale runner: restart budget (' || ${task.restarts} || ') exhausted'`,
      })
      .where(
        and(
          inArray(task.status, [TaskStatus.STARTING, TaskStatus.RUNNING]),
          this.heartbeatSilentFor(staleAfterMs),
          gte(task.restarts, maxRestarts),
        ),
      )
      .returning({ id: task.id });
    return deadLettered.map((r) => r.id);
  }

  /**
   * The third zombie: a task stuck `ingesting` because the API died
   * mid-stream. Never claimable, so the reclaim above can't see it — fail it
   * once its ingestion stops making progress (addRows touches updated_at).
   */
  async failStaleIngesting(staleAfterMs: number): Promise<string[]> {
    const failed = await this.db
      .update(task)
      .set({
        status: TaskStatus.FAILED,
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
        error: `ingestion stalled: no progress for ${staleAfterMs / 1000}s`,
      })
      .where(
        and(
          eq(task.status, TaskStatus.INGESTING),
          lt(task.updatedAt, this.staleCutoff(staleAfterMs)),
        ),
      )
      .returning({ id: task.id });
    return failed.map((r) => r.id);
  }

  // ── Dead-letter replay ───────────────────────────────────────────────────

  /**
   * Replay a failed task: flip its dead-lettered rows back to `pending` with a
   * fresh attempts budget, then re-publish the task. `done` rows are untouched
   * — the standard resume drains only what's left, so no-double-apply holds
   * for replays too. One transaction: a half-replayed task can't be observed.
   */
  async retryFailed(taskId: string): Promise<RetryOutcome> {
    return this.db.transaction(async (tx): Promise<RetryOutcome> => {
      const [t] = await tx
        .select({ status: task.status, totalRows: task.totalRows })
        .from(task)
        .where(eq(task.id, taskId))
        .for("update");
      if (!t) return { outcome: "not_found" };
      if (t.status !== TaskStatus.FAILED) return { outcome: "not_failed" };
      // Failed during ingestion: never fully stored, replaying would run a
      // partial job. Submit it again instead.
      if (t.totalRows === 0) return { outcome: "never_published" };

      const retried = await tx
        .update(taskRow)
        .set({ status: TaskRowStatus.PENDING, attempts: 0 })
        .where(
          and(
            eq(taskRow.taskId, taskId),
            eq(taskRow.status, TaskRowStatus.FAILED),
          ),
        )
        .returning({ id: taskRow.id });

      await tx
        .update(task)
        .set({
          status: TaskStatus.PENDING,
          error: null,
          finishedAt: null,
          runnerPid: null,
          // Same reset as reclaimStale: a leftover beat from the failed run
          // would read as stale the moment the replay is claimed.
          heartbeatAt: null,
          restarts: 0,
          epoch: sql`${task.epoch} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(task.id, taskId));

      return { outcome: "retried", retriedRows: retried.length };
    });
  }

  /**
   * Server-side staleness cutoff (`now() - interval`): staleness is judged
   * against the server clock, so client clock skew must not enter it.
   */
  private staleCutoff(staleAfterMs: number) {
    return sql`now() - make_interval(secs => ${staleAfterMs / 1000})`;
  }

  /** A claimed task's liveness signal, silent for longer than the cutoff. */
  private heartbeatSilentFor(staleAfterMs: number) {
    return lt(
      sql`coalesce(${task.heartbeatAt}, ${task.startedAt})`,
      this.staleCutoff(staleAfterMs),
    );
  }
}
