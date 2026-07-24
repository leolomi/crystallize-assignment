import { errorMessage } from "@crystallize/shared";
import {
  classifyWeight,
  type TaskKind,
  type TaskPayloads,
  TaskRepository,
  TaskRowRepository,
  TaskStatus,
  type TaskWeight,
} from "@crystallize/tasks";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";

import { appConfig } from "../config/app.config";

export const INGEST_BATCH = 1000;

export interface IngestResult {
  id: string;
  kind: TaskKind;
  status: TaskStatus.PENDING;
  totalRows: number;
  weight: TaskWeight;
}

/**
 * The write path of every POST /tasks/* endpoint, kind-agnostic: callers hand
 * over already-validated payloads (an array for JSON bodies, a validating
 * AsyncGenerator for NDJSON streams — see ndjsonStream) and this service owns
 * the persistence choreography only.
 *
 * Payloads are consumed as they arrive and inserted in batches, so a 50k-row
 * stream is never buffered whole in memory. The task is created lazily on the
 * first payload, `ingesting`, and flipped to `pending` only after the last row
 * is committed — publishing IS that flip: the dispatcher's poll picks the task
 * up from Postgres directly, so there is no broker to notify and no dual-write
 * to lose.
 */
@Injectable()
export class TaskIngestionService {
  private readonly inlineThresholdRows: number;

  constructor(
    private readonly repo: TaskRepository,
    private readonly rowRepo: TaskRowRepository,
    @Inject(appConfig.KEY) config: ConfigType<typeof appConfig>,
  ) {
    this.inlineThresholdRows = config.inlineThresholdRows;
  }

  async ingest<K extends TaskKind>(
    kind: K,
    payloads: Iterable<TaskPayloads[K]> | AsyncIterable<TaskPayloads[K]>,
  ): Promise<IngestResult> {
    let taskId: string | null = null;
    let batch: { rowIndex: number; payload: TaskPayloads[K] }[] = [];
    let count = 0;

    try {
      for await (const payload of payloads) {
        // First payload creates the task; an all-invalid or empty body never does.
        taskId ??= await this.repo.createTask(kind);
        batch.push({ rowIndex: count++, payload });
        if (batch.length >= INGEST_BATCH) {
          await this.rowRepo.addRows(taskId, batch);
          batch = [];
        }
      }
      if (taskId && batch.length > 0) {
        await this.rowRepo.addRows(taskId, batch);
      }
    } catch (err) {
      // Ingestion failed (invalid line mid-stream, insert error): the task
      // never left `ingesting`, so it was never claimable. Mark it failed for
      // observability and bail.
      if (taskId) {
        await this.repo.markFailed(taskId, errorMessage(err));
      }
      throw err;
    }

    if (!taskId || count === 0) {
      throw new BadRequestException("Empty job: no rows");
    }

    const weight = classifyWeight(kind, count, this.inlineThresholdRows);
    await this.repo.setTotalRows(taskId, count);
    await this.repo.markPending(taskId, weight);

    return {
      id: taskId,
      kind,
      status: TaskStatus.PENDING,
      totalRows: count,
      weight,
    };
  }
}
