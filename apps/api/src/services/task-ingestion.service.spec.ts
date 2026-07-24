import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  TaskKind,
  type TaskRepository,
  type TaskRowRepository,
  TaskStatus,
  TaskWeight,
} from "@crystallize/tasks";
import { BadRequestException } from "@nestjs/common";

import { createMock } from "../../../../test-utils/mocks";
import { INGEST_BATCH, TaskIngestionService } from "./task-ingestion.service";

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i}`, price: i + 0.5 }));

/**
 * Unit tests for the kind-agnostic persistence choreography — possible because
 * all persistence lives behind the repositories and validation belongs to the
 * callers (zod body schemas / ndjsonStream). Plain constructor injection with
 * createMock deps; no Nest context, no database.
 */
describe("TaskIngestionService.ingest", () => {
  const repo = createMock<TaskRepository>();
  const rowRepo = createMock<TaskRowRepository>();
  let service: TaskIngestionService;

  beforeEach(() => {
    mock.clearAllMocks();
    repo.createTask.mockResolvedValue("task-1");
    service = new TaskIngestionService(repo, rowRepo, {
      port: 3000,
      inlineThresholdRows: 1000,
    });
  });

  it("creates the task on the first payload, inserts rows, then publishes", async () => {
    const result = await service.ingest(TaskKind.PRODUCT_PRICE_UPDATE, rows(2));

    expect(result).toEqual({
      id: "task-1",
      kind: TaskKind.PRODUCT_PRICE_UPDATE,
      status: TaskStatus.PENDING,
      totalRows: 2,
      weight: TaskWeight.LIGHT, // 2 rows, under the inline threshold
    });
    expect(repo.createTask).toHaveBeenCalledWith(TaskKind.PRODUCT_PRICE_UPDATE);
    expect(rowRepo.addRows).toHaveBeenCalledWith("task-1", [
      { rowIndex: 0, payload: { id: "p0", price: 0.5 } },
      { rowIndex: 1, payload: { id: "p1", price: 1.5 } },
    ]);
    expect(repo.setTotalRows).toHaveBeenCalledWith("task-1", 2);
    // Publish (markPending) must come last — after every row is committed.
    expect(repo.markPending).toHaveBeenCalledWith("task-1", TaskWeight.LIGHT);
    const publishedAt = repo.markPending.mock.invocationCallOrder[0];
    expect(publishedAt).toBeGreaterThan(
      rowRepo.addRows.mock.invocationCallOrder.at(-1) ??
        Number.POSITIVE_INFINITY,
    );
    expect(publishedAt).toBeGreaterThan(
      repo.setTotalRows.mock.invocationCallOrder[0],
    );
  });

  it("accepts a catalogue_reindex payload (single-row job)", async () => {
    const result = await service.ingest(TaskKind.CATALOGUE_REINDEX, [
      { catalogue: "products" },
    ]);
    expect(result.kind).toBe(TaskKind.CATALOGUE_REINDEX);
    expect(result.totalRows).toBe(1);
    // One row, but heavy by nature: a re-index is long regardless of row count.
    expect(result.weight).toBe(TaskWeight.HEAVY);
  });

  it("classifies a bulk task above the inline threshold as heavy", async () => {
    async function* stream() {
      yield* rows(1001);
    }
    const result = await service.ingest(
      TaskKind.PRODUCT_PRICE_UPDATE,
      stream(),
    );
    expect(result.weight).toBe(TaskWeight.HEAVY);
    expect(repo.markPending).toHaveBeenCalledWith("task-1", TaskWeight.HEAVY);
  });

  it("consumes an AsyncIterable, flushing in INGEST_BATCH-sized inserts", async () => {
    async function* stream() {
      yield* rows(INGEST_BATCH + 1);
    }
    const result = await service.ingest(
      TaskKind.PRODUCT_PRICE_UPDATE,
      stream(),
    );

    expect(result.totalRows).toBe(INGEST_BATCH + 1);
    const batches = rowRepo.addRows.mock.calls.map(([, batch]) => batch);
    expect(batches.map((b) => b.length)).toEqual([INGEST_BATCH, 1]);
    // Row indexes are contiguous across batch boundaries.
    expect(batches[1][0].rowIndex).toBe(INGEST_BATCH);
  });

  it("rejects an empty job without creating a task", async () => {
    expect(service.ingest(TaskKind.PRODUCT_PRICE_UPDATE, [])).rejects.toThrow(
      BadRequestException,
    );
    expect(repo.createTask).not.toHaveBeenCalled();
  });

  it("marks the task failed and rethrows when the stream errors mid-flight, never publishing", async () => {
    async function* failing() {
      yield* rows(1);
      throw new BadRequestException("line 2: invalid JSON");
    }
    expect(
      service.ingest(TaskKind.PRODUCT_PRICE_UPDATE, failing()),
    ).rejects.toThrow("line 2: invalid JSON");

    expect(repo.markFailed).toHaveBeenCalledWith(
      "task-1",
      "line 2: invalid JSON",
    );
    expect(repo.markPending).not.toHaveBeenCalled();
  });

  it("does not create a task when the stream errors before the first payload", async () => {
    // biome-ignore lint/correctness/useYield: the point IS a stream that throws before its first payload
    async function* failing(): AsyncGenerator<{ id: string; price: number }> {
      throw new BadRequestException("line 1: invalid JSON");
    }
    expect(
      service.ingest(TaskKind.PRODUCT_PRICE_UPDATE, failing()),
    ).rejects.toThrow("line 1: invalid JSON");
    expect(repo.createTask).not.toHaveBeenCalled();
    expect(repo.markFailed).not.toHaveBeenCalled();
  });

  it("marks the task failed and rethrows when a repository insert fails", async () => {
    // Once: clearAllMocks resets calls, not implementations — a persistent
    // rejection would leak into later tests.
    rowRepo.addRows.mockRejectedValueOnce(new Error("db down"));

    // Enough rows to force a mid-stream flush.
    expect(
      service.ingest(TaskKind.PRODUCT_PRICE_UPDATE, rows(INGEST_BATCH)),
    ).rejects.toThrow("db down");
    expect(repo.markFailed).toHaveBeenCalledWith("task-1", "db down");
    expect(repo.markPending).not.toHaveBeenCalled();
  });
});
