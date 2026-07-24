import { errorMessage } from "@crystallize/shared";
import {
  type PendingRow,
  RowSupersededError,
  StaleRunnerError,
  type TaskOwner,
  type TaskRecord,
  TaskRepository,
  TaskRowRepository,
  TaskStatus,
} from "@crystallize/tasks";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { match } from "ts-pattern";
import { runnerConfig } from "../config/runner.config";
import {
  type RowProcessor,
  RowProcessorRegistry,
} from "../processors/row-processor";
import { mapPool } from "../utils/map-pool";
import { interruptibleSleep, isAbortError } from "../utils/sleep";
import { RowExecutor } from "./row-executor.service";

/** DI token for the RunnerService factory — wired in ExecutionModule. */
export const RUNNER_FACTORY = Symbol("RUNNER_FACTORY");

/**
 * Per-instance tweaks a caller may apply when building a runner: `processors`
 * is the test seam for substituting a fake registry; `concurrency` lets the
 * inline path run lighter than a dedicated runner process (its rows share the
 * dispatcher's pg pool with every other inline run).
 */
export type RunnerOverrides = {
  processors?: RowProcessorRegistry;
  concurrency?: number;
};

/**
 * Builds a fresh RunnerService per task. Each run owns its drain / stand-down
 * state, so a singleton would be wrong — the factory is the container-owned way
 * to hand out a new instance per task without a manual `new` at the call site.
 * Its dependencies are wired once in ExecutionModule.
 */
export type RunnerFactory = (overrides?: RunnerOverrides) => RunnerService;

/** A resolved claim: the ownership fence plus the task it covers. */
type Claim = { owner: TaskOwner; task: TaskRecord };

/**
 * How one row ended: `done` and `failed` are the countable outcomes (progress
 * and backoff); `skipped` covers everything that must count as neither — a
 * peer settled the row, the drain interrupted it, or the task was lost.
 */
type RowOutcome = "done" | "failed" | "skipped";

/** What a page contributed: feeds the progress checkpoint and the backoff. */
type PageCounts = { done: number; failed: number };

/**
 * The one-shot runner. Started with a task id, it resolves the processor for the
 * task's kind, drains the task's pending rows with bounded concurrency,
 * checkpoints, finalizes, and exits. Running the same task id twice is safe —
 * the second run resumes where the first stopped.
 *
 * Ownership: for a claimed task (`starting`/`running` — the dispatcher path
 * and the crash-resume path) the runner captures the task's `epoch` at start;
 * for a still-`pending` task (manual fire) it performs the SAME atomic claim
 * the dispatcher would, so a manual runner and the dispatcher can never both
 * run it. Every write is fenced on the epoch and the runner proves liveness on
 * a timer (heartbeat). If the sweeper reclaims the task (bumping the epoch),
 * the first fenced write to miss makes this runner stand down without
 * finalizing.
 */
@Injectable()
export class RunnerService {
  private readonly log = new Logger(RunnerService.name);
  private draining = false;
  private lostOwnership = false;
  private readonly abort = new AbortController();

  constructor(
    private readonly repo: TaskRepository,
    private readonly rowRepo: TaskRowRepository,
    private readonly executor: RowExecutor,
    private readonly processors: RowProcessorRegistry,
    @Inject(runnerConfig.KEY)
    private readonly config: ConfigType<typeof runnerConfig>,
  ) {}

  /**
   * SIGTERM handler: stop starting new rows and abort any in-flight long op.
   * In-flight transaction-local rows still commit; interrupted external rows
   * are left pending for the next run.
   */
  requestDrain() {
    if (!this.draining) {
      this.draining = true;
      this.abort.abort();
      this.log.warn("SIGTERM received — draining, then exiting");
    }
  }

  /** The sweeper took the task from us: stop everything, finalize nothing. */
  private standDown(taskId: string) {
    if (!this.lostOwnership) {
      this.lostOwnership = true;
      this.draining = true;
      this.abort.abort();
      this.log.warn(
        `Task [${taskId}] was reclaimed (epoch advanced) — standing down`,
      );
    }
  }

  /**
   * Resolve our claim on the task, or null when there is nothing to run.
   * Terminal and half-ingested tasks are refused; a `pending` task is claimed
   * atomically (racing the dispatcher: exactly one wins).
   */
  private async acquire(taskId: string): Promise<Claim | null> {
    const task = await this.repo.getTask(taskId);
    if (!task) throw new Error(`task ${taskId} does not exist`);

    return match(task.status)
      .with(TaskStatus.COMPLETED, () => this.handleCompleted(task))
      .with(TaskStatus.FAILED, () => this.handleFailed(task))
      .with(TaskStatus.INGESTING, () => this.handleIngesting(task))
      .with(TaskStatus.PENDING, () => this.handlePending(task))
      .with(TaskStatus.STARTING, TaskStatus.RUNNING, () =>
        this.handleClaimed(task),
      )
      .exhaustive();
  }

  private handleCompleted(task: TaskRecord): null {
    this.log.log(`Task [${task.id}] already completed — nothing to do`);
    return null;
  }

  private handleFailed(task: TaskRecord): null {
    this.log.warn(
      `Task [${task.id}] is failed — use POST /tasks/${task.id}/retry to replay it`,
    );
    return null;
  }

  private handleIngesting(task: TaskRecord): null {
    this.log.warn(`Task [${task.id}] is still ingesting — not runnable yet`);
    return null;
  }

  /** Manual fire before any dispatcher claim: take the claim ourselves. */
  private async handlePending(task: TaskRecord): Promise<Claim | null> {
    const epoch = await this.repo.claimPending(task.id);
    if (epoch === null) {
      this.log.warn(
        `Task [${task.id}] was claimed by another process — exiting`,
      );
      return null;
    }
    return { owner: { taskId: task.id, epoch }, task };
  }

  /** Claimed for us (dispatcher path) or resuming a dead runner's claim. */
  private handleClaimed(task: TaskRecord): Claim {
    return { owner: { taskId: task.id, epoch: task.epoch }, task };
  }

  async run(taskId: string): Promise<void> {
    const acquired = await this.acquire(taskId);
    if (!acquired) return;
    const { owner, task } = acquired;
    const processor = this.processors.get(task.kind);

    const initialDone = await this.beginRun(owner, task);
    if (initialDone === null) return;

    const stopHeartbeat = this.startHeartbeat(owner);
    try {
      await this.drainRows(owner, processor, initialDone, task.totalRows);
    } finally {
      stopHeartbeat();
    }

    await this.finalize(owner);
  }

  /**
   * Fence the `running` transition and take the starting checkpoint. Returns
   * the initial done count, or null when the task is no longer ours.
   */
  private async beginRun(
    owner: TaskOwner,
    task: TaskRecord,
  ): Promise<number | null> {
    const running = await this.repo.markRunning(owner, process.pid);
    if (!running) {
      this.log.warn(
        `Task [${owner.taskId}] is no longer ours (epoch moved) — exiting`,
      );
      return null;
    }
    this.log.log(
      `Running task [${owner.taskId}] [kind=${task.kind}] (pid ${process.pid}, epoch ${owner.epoch}, concurrency ${this.config.concurrency})`,
    );

    // One full recount at the start: heals any drift a crashed predecessor
    // left between its last committed rows and its last checkpoint. Per-page
    // progress is then advanced incrementally (O(1) per page).
    const initialDone = await this.repo.recomputeProgress(owner);
    if (initialDone === null) {
      this.standDown(owner.taskId);
      return null;
    }
    return initialDone;
  }

  /**
   * Liveness proof on its own timer, decoupled from row throughput: a long
   * external op must not read as dead. A missed beat means we lost the task.
   * Returns the function that stops the timer.
   */
  private startHeartbeat(owner: TaskOwner): () => void {
    const beat = setInterval(() => {
      this.repo
        .heartbeat(owner)
        .then((owned) => {
          if (!owned) this.standDown(owner.taskId);
        })
        // A transient DB error is not a lost claim — the sweeper decides.
        .catch(() => {});
    }, this.config.heartbeatIntervalMs);
    return () => clearInterval(beat);
  }

  /**
   * Post-drain epilogue: exact recount at the boundary, then the terminal
   * transition — failed when rows were dead-lettered, completed otherwise.
   * A drained (SIGTERM) task is left resumable instead.
   */
  private async finalize(owner: TaskOwner): Promise<void> {
    const { taskId } = owner;
    if (this.lostOwnership) return; // a newer runner owns the task now

    // Exact terminal numbers: one recount + one aggregate, at the boundary.
    const recounted = await this.repo.recomputeProgress(owner);
    if (recounted === null) {
      this.standDown(taskId);
      return;
    }

    if (this.draining) {
      this.log.warn(`Drained cleanly, task [${taskId}] left resumable`);
      return;
    }

    const counts = await this.rowRepo.countRows(taskId);
    if (counts.failed > 0) {
      await this.repo.markFailed(
        taskId,
        `${counts.failed} row(s) exhausted retries`,
        owner.epoch,
      );
      this.log.error(
        `Task [${taskId}] FAILED: ${counts.failed}/${counts.total} rows dead-lettered`,
      );
      return;
    }

    const completed = await this.repo.markCompleted(owner);
    if (!completed) {
      this.standDown(taskId);
      return;
    }
    this.log.log(
      `Task [${taskId}] COMPLETED: ${counts.done}/${counts.total} rows`,
    );
  }

  /**
   * The page loop: fetch the next slice of pending rows, run it through the
   * pool, checkpoint the page's progress, back off if it recorded failures.
   * Loops until the task has no runnable row left (or the drain/stand-down
   * flags stop it).
   */
  private async drainRows(
    owner: TaskOwner,
    processor: RowProcessor,
    initialDone: number,
    totalRows: number,
  ): Promise<void> {
    let done = initialDone;

    while (!this.draining) {
      const rows = await this.rowRepo.fetchPendingRows(
        owner.taskId,
        this.config.maxAttempts,
        this.config.batchSize,
      );
      if (rows.length === 0) break;

      const page = await this.processPage(owner, processor, rows);
      if (this.lostOwnership) return;

      const advanced = await this.repo.advanceProgress(owner, page.done);
      if (!advanced) {
        this.standDown(owner.taskId);
        return;
      }
      done += page.done;
      this.log.log(
        `Progress ${done}/${totalRows} done (+${page.done} this page, ${page.failed} failure(s))`,
      );

      if (page.failed > 0) await this.backOffBeforeRetry();
    }
  }

  /** One page through the bounded pool, tallying each row's outcome. */
  private async processPage(
    owner: TaskOwner,
    processor: RowProcessor,
    rows: PendingRow[],
  ): Promise<PageCounts> {
    const counts: PageCounts = { done: 0, failed: 0 };
    await mapPool(
      rows,
      this.config.concurrency,
      async (row) => {
        const outcome = await this.executeRow(owner, processor, row);
        if (outcome !== "skipped") counts[outcome]++;
      },
      () => this.draining,
    );
    return counts;
  }

  /** One row: apply the effect + checkpoint flip, triaging every failure. */
  private async executeRow(
    owner: TaskOwner,
    processor: RowProcessor,
    row: PendingRow,
  ): Promise<RowOutcome> {
    try {
      await this.executor.execute(processor, row, owner, this.abort.signal);
      return "done";
    } catch (err) {
      return this.settleRowError(owner, row, err);
    }
  }

  /**
   * Failure triage — only a genuine row failure records an attempt:
   *
   *   - StaleRunnerError: the task was reclaimed -> stand down, not a row
   *     failure;
   *   - RowSupersededError: a same-claim peer settled this row first -> its
   *     outcome stands, skip it and keep draining;
   *   - aborted mid-drain: the row stays pending for the next run, no failed
   *     attempt;
   *   - anything else: record it (dead-letter at the attempts cap). A missed
   *     failure write disambiguates exactly like a missed mark-done: epoch
   *     moved -> stand down; epoch held -> a peer settled the row.
   */
  private async settleRowError(
    owner: TaskOwner,
    row: PendingRow,
    err: unknown,
  ): Promise<RowOutcome> {
    if (err instanceof StaleRunnerError) {
      this.standDown(owner.taskId);
      return "skipped";
    }
    if (err instanceof RowSupersededError) return "skipped";
    if (this.draining && isAbortError(err)) return "skipped";

    const recorded = await this.rowRepo.recordRowFailure(
      row.id,
      owner,
      errorMessage(err),
      this.config.maxAttempts,
    );
    if (recorded) return "failed";

    const owned = await this.repo.ownershipHolds(owner);
    if (!owned) this.standDown(owner.taskId);
    return "skipped";
  }

  /**
   * Space out retries: a failed row stays pending and would be refetched
   * immediately — without this, its attempts burn in a hot loop.
   */
  private async backOffBeforeRetry(): Promise<void> {
    if (this.config.retryBackoffMs === 0 || this.draining) return;
    await interruptibleSleep(this.config.retryBackoffMs, this.abort.signal)
      // Aborted mid-backoff: the page loop's condition exits for us.
      .catch(() => {});
  }
}
