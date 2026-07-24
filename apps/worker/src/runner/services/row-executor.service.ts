import {
  type PendingRow,
  RowSupersededError,
  StaleRunnerError,
  type TaskOwner,
  type TaskPayload,
  TaskRepository,
  TaskRowRepository,
} from "@crystallize/tasks";
import { Injectable } from "@nestjs/common";
import type { RowProcessor } from "../processors/row-processor";

/**
 * Runs one row through its processor and marks it done — effect first, then the
 * checkpoint flip as a separate commit. The ordering is the guarantee: a crash
 * between the two leaves the row `pending`, so the effect is replayed, which
 * is safe because every processor is idempotent (see RowProcessor). The reverse
 * order would have a crash window where the row is `done` but the effect never
 * happened — and nothing would ever re-run it.
 *
 * On success the row is `done`. On failure the error propagates to the runner,
 * which records the attempt (and dead-letters after the cap).
 */
@Injectable()
export class RowExecutor {
  constructor(
    private readonly repo: TaskRepository,
    private readonly rowRepo: TaskRowRepository,
  ) {}

  async execute(
    processor: RowProcessor,
    row: PendingRow,
    owner: TaskOwner,
    signal: AbortSignal,
  ): Promise<void> {
    // The jsonb boundary: rows were shape-validated at ingestion, so this cast
    // is the (single) point where that guarantee re-enters the type system.
    const payload = row.payload as TaskPayload;

    await processor.apply(payload, signal);
    const marked = await this.rowRepo.markRowDone(row.id, owner);
    if (!marked) {
      throw await this.markDoneMissError(row, owner);
    }
  }

  /**
   * A missed mark-done means one of two very different things: the epoch
   * moved (task reclaimed -> the runner must stand down) or only this row was
   * settled by a concurrent runner of the same claim (-> skip it and keep
   * draining). Conflating them would make two racing runners both stand down,
   * leaving the task unfinalized.
   */
  private async markDoneMissError(
    row: PendingRow,
    owner: TaskOwner,
  ): Promise<Error> {
    const owned = await this.repo.ownershipHolds(owner);
    return owned
      ? new RowSupersededError(owner.taskId, row.id)
      : new StaleRunnerError(owner.taskId);
  }
}
