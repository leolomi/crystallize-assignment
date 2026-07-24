import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DatabaseModule,
  DRIZZLE_DATABASE_PROVIDER,
  type DrizzleDatabaseProvider,
  dbConfig,
  schema,
} from "@crystallize/database";
import { type INestApplicationContext, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { eq, sql } from "drizzle-orm";

import { TaskModule } from "../task.module";
import { TaskKind, TaskStatus, TaskWeight } from "../types/task.enums";
import type { TaskOwner } from "../types/task.types";
import { TaskRowStatus } from "../types/task-row.enums";
import { TaskRepository } from "./task.repository";
import { TaskRowRepository } from "./task-row.repository";

const ANY_WEIGHT = [TaskWeight.LIGHT, TaskWeight.HEAVY];

/**
 * Integration tests for the guarantees the demos rely on, at the repository
 * level: the atomic claim, the epoch fence, and the `pending` guard on
 * mark-done — the checkpoint flip the crash-resume story rests on.
 * Runs against the throwaway docker Postgres (see test-utils/global-setup.ts).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [dbConfig] }),
    DatabaseModule,
    TaskModule,
  ],
})
class RepoTestModule {}

let ctx: INestApplicationContext;
let repo: TaskRepository;
let rowRepo: TaskRowRepository;
let db: DrizzleDatabaseProvider;

beforeAll(async () => {
  ctx = await NestFactory.createApplicationContext(RepoTestModule, {
    logger: false,
  });
  repo = ctx.get(TaskRepository);
  rowRepo = ctx.get(TaskRowRepository);
  db = ctx.get(DRIZZLE_DATABASE_PROVIDER);
});

afterAll(async () => {
  await ctx.close();
});

/** Create a published (claimable) product task with `n` rows. */
async function publishTask(
  n: number,
  weight: TaskWeight = TaskWeight.LIGHT,
): Promise<string> {
  const taskId = await repo.createTask(TaskKind.PRODUCT_PRICE_UPDATE);
  await rowRepo.addRows(
    taskId,
    Array.from({ length: n }, (_, i) => ({
      rowIndex: i,
      payload: { id: `prod-${i}`, price: i + 1 },
    })),
  );
  await repo.setTotalRows(taskId, n);
  await repo.markPending(taskId, weight);
  return taskId;
}

async function taskStatus(taskId: string): Promise<string> {
  const t = await repo.getTask(taskId);
  return t?.status ?? "missing";
}

describe("claim (the queue's consume)", () => {
  it("claims the oldest pending task and flips it to starting", async () => {
    const first = await publishTask(1);
    const second = await publishTask(1);

    expect((await repo.claimNextPending(ANY_WEIGHT))?.id).toBe(first);
    expect(await taskStatus(first)).toBe("starting");
    expect((await repo.claimNextPending(ANY_WEIGHT))?.id).toBe(second);
    expect(await repo.claimNextPending(ANY_WEIGHT)).toBeNull();
  });

  it("claims only the requested weights (threshold routing)", async () => {
    const light = await publishTask(1, TaskWeight.LIGHT);
    const heavy = await publishTask(1, TaskWeight.HEAVY);

    // Heavy lane only: skips the older light task.
    expect(await repo.claimNextPending([TaskWeight.HEAVY])).toEqual({
      id: heavy,
      weight: TaskWeight.HEAVY,
    });
    expect(await repo.claimNextPending([TaskWeight.HEAVY])).toBeNull();
    // The light task is still pending for a claim that can take it.
    expect((await repo.claimNextPending(ANY_WEIGHT))?.id).toBe(light);
    // No weights (both lanes full) never claims.
    expect(await repo.claimNextPending([])).toBeNull();
  });

  it("never hands the same task to two concurrent claimers", async () => {
    const taskId = await publishTask(1);
    const claims = await Promise.all([
      repo.claimNextPending(ANY_WEIGHT),
      repo.claimNextPending(ANY_WEIGHT),
    ]);
    expect(claims.filter((c) => c?.id === taskId)).toHaveLength(1);
    expect(claims.filter((c) => c === null)).toHaveLength(1);
  });

  it("claimPending (manual runner) wins exactly once against the same flip", async () => {
    const taskId = await publishTask(1);
    const [a, b] = await Promise.all([
      repo.claimPending(taskId),
      repo.claimPending(taskId),
    ]);
    // Exactly one got the epoch, the other saw the task already claimed.
    expect([a, b].filter((e) => e !== null)).toHaveLength(1);
  });
});

describe("recordRowFailure guards (the failure-path twin of markRowDone)", () => {
  it("refuses a row a same-claim peer already settled (no resurrection)", async () => {
    const taskId = await publishTask(1);
    const owner: TaskOwner = { taskId, epoch: 0 };
    const [row] = await rowRepo.fetchPendingRows(taskId, 3, 10);

    // Peer B settles the row; loser A's effect then throws and A tries to
    // record the failure — it must miss, not flip the row back to pending.
    expect(await rowRepo.markRowDone(row.id, owner)).toBe(true);
    expect(await rowRepo.recordRowFailure(row.id, owner, "boom", 3)).toBe(
      false,
    );

    const [stored] = await db
      .select({
        status: schema.taskRow.status,
        attempts: schema.taskRow.attempts,
      })
      .from(schema.taskRow)
      .where(eq(schema.taskRow.id, row.id));
    expect(stored.status).toBe(TaskRowStatus.DONE); // the peer's outcome stands
    expect(stored.attempts).toBe(1); // no stolen attempt
  });

  it("refuses a write once the epoch moved (fenced-out zombie)", async () => {
    const taskId = await publishTask(1);
    const owner: TaskOwner = { taskId, epoch: 0 };
    const [row] = await rowRepo.fetchPendingRows(taskId, 3, 10);

    // Simulate the sweeper's reclaim: bump the fence.
    await db
      .update(schema.task)
      .set({ epoch: sql`${schema.task.epoch} + 1` })
      .where(eq(schema.task.id, taskId));

    expect(await rowRepo.recordRowFailure(row.id, owner, "boom", 3)).toBe(
      false,
    );

    // The new owner's view of the row is untouched: still pending, no
    // attempts burned toward its dead-letter cap.
    const [stored] = await db
      .select({
        status: schema.taskRow.status,
        attempts: schema.taskRow.attempts,
      })
      .from(schema.taskRow)
      .where(eq(schema.taskRow.id, row.id));
    expect(stored.status).toBe(TaskRowStatus.PENDING);
    expect(stored.attempts).toBe(0);
  });
});

describe("markRowDone guards", () => {
  it("refuses a row that is already done (same epoch — concurrent runner race)", async () => {
    const taskId = await publishTask(1);
    const owner: TaskOwner = { taskId, epoch: 0 };
    const [row] = await rowRepo.fetchPendingRows(taskId, 3, 10);

    expect(await rowRepo.markRowDone(row.id, owner)).toBe(true);
    expect(await rowRepo.markRowDone(row.id, owner)).toBe(false);

    // The attempt was counted once, not twice.
    const [stored] = await db
      .select({ attempts: schema.taskRow.attempts })
      .from(schema.taskRow)
      .where(eq(schema.taskRow.id, row.id));
    expect(stored.attempts).toBe(1);
  });

  it("refuses a write once the epoch moved (sweeper reclaimed the task)", async () => {
    const taskId = await publishTask(1);
    const owner: TaskOwner = { taskId, epoch: 0 };
    const [row] = await rowRepo.fetchPendingRows(taskId, 3, 10);

    // Simulate the sweeper's reclaim: bump the fence.
    await db
      .update(schema.task)
      .set({ epoch: sql`${schema.task.epoch} + 1` })
      .where(eq(schema.task.id, taskId));

    expect(await rowRepo.markRowDone(row.id, owner)).toBe(false);
    expect(await repo.heartbeat(owner)).toBe(false);
    expect(await repo.markCompleted(owner)).toBe(false);
  });
});

describe("the sweeper's recovery queries", () => {
  /** Age a claim past the staleness threshold (no heartbeat ever beaten). */
  async function ageClaim(taskId: string, restarts = 0): Promise<void> {
    await db
      .update(schema.task)
      .set({ startedAt: sql`now() - interval '60 seconds'`, restarts })
      .where(eq(schema.task.id, taskId));
  }

  it("reclaimStale re-pends a silent claim, bumping epoch and restarts", async () => {
    const taskId = await publishTask(1);
    await repo.claimNextPending(ANY_WEIGHT);
    await ageClaim(taskId);

    expect(await repo.reclaimStale(30_000, 3)).toEqual([taskId]);

    const t = await repo.getTask(taskId);
    expect(t?.status).toBe(TaskStatus.PENDING); // re-published: the claim path re-fires it
    expect(t?.epoch).toBe(1); // the old runner is fenced out
    expect(t?.restarts).toBe(1);
  });

  it("clears the dead runner's beat, so the re-claim is not instantly stale", async () => {
    const taskId = await publishTask(1);
    await repo.claimNextPending(ANY_WEIGHT);
    // The runner beat once, then died: a stale heartbeat_at is left behind.
    await db
      .update(schema.task)
      .set({
        startedAt: sql`now() - interval '60 seconds'`,
        heartbeatAt: sql`now() - interval '60 seconds'`,
      })
      .where(eq(schema.task.id, taskId));

    expect(await repo.reclaimStale(30_000, 3)).toEqual([taskId]);
    expect((await repo.getTask(taskId))?.heartbeatAt).toBeNull();

    // Re-claimed: staleness falls back to the fresh started_at, so a sweep
    // tick landing in the new runner's boot window must NOT re-reclaim it —
    // otherwise one stall would cascade through the whole restart budget.
    await repo.claimNextPending(ANY_WEIGHT);
    expect(await repo.reclaimStale(30_000, 3)).toEqual([]);
    expect(await taskStatus(taskId)).toBe("starting");
  });

  it("leaves a live (recently-beating) claim alone", async () => {
    const taskId = await publishTask(1);
    await repo.claimNextPending(ANY_WEIGHT); // started_at = now(): not stale
    expect(await repo.reclaimStale(30_000, 3)).toEqual([]);
    expect(await taskStatus(taskId)).toBe("starting");
  });

  it("deadLetterStale fails a stale task that burned its restart budget", async () => {
    const taskId = await publishTask(1);
    await repo.claimNextPending(ANY_WEIGHT);
    await ageClaim(taskId, 3); // budget exhausted

    expect(await repo.reclaimStale(30_000, 3)).toEqual([]); // not re-pended…
    expect(await repo.deadLetterStale(30_000, 3)).toEqual([taskId]); // …failed

    const t = await repo.getTask(taskId);
    expect(t?.status).toBe(TaskStatus.FAILED);
    expect(t?.error).toContain("restart budget");
  });

  it("failStaleIngesting fails a task whose ingestion stopped making progress", async () => {
    const taskId = await repo.createTask(TaskKind.PRODUCT_PRICE_UPDATE);
    await db
      .update(schema.task)
      .set({ updatedAt: sql`now() - interval '60 seconds'` })
      .where(eq(schema.task.id, taskId));

    expect(await repo.failStaleIngesting(30_000)).toEqual([taskId]);
    expect(await taskStatus(taskId)).toBe("failed");
  });
});

describe("the resume query and the dead-letter path", () => {
  it("fetchPendingRows skips done rows and dead-lettered rows", async () => {
    const taskId = await publishTask(3);
    const owner: TaskOwner = { taskId, epoch: 0 };
    const rows = await rowRepo.fetchPendingRows(taskId, 3, 10);

    await rowRepo.markRowDone(rows[0].id, owner);
    // Exhaust row 1's attempts: recordRowFailure dead-letters at the cap.
    await rowRepo.recordRowFailure(rows[1].id, owner, "boom", 3);
    await rowRepo.recordRowFailure(rows[1].id, owner, "boom", 3);
    await rowRepo.recordRowFailure(rows[1].id, owner, "boom", 3);

    const remaining = await rowRepo.fetchPendingRows(taskId, 3, 10);
    expect(remaining.map((r) => r.rowIndex)).toEqual([2]);

    const dead = await rowRepo.fetchFailedRows(taskId, 10, 0);
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ rowIndex: 1, error: "boom", attempts: 3 });
  });

  it("retryFailed re-pends only the failed rows, with a bumped epoch", async () => {
    const taskId = await publishTask(2);
    const owner: TaskOwner = { taskId, epoch: 0 };
    const rows = await rowRepo.fetchPendingRows(taskId, 3, 10);

    await rowRepo.markRowDone(rows[0].id, owner);
    await rowRepo.recordRowFailure(rows[1].id, owner, "boom", 1); // dead-letters at cap 1
    await repo.markFailed(taskId, "1 row(s) exhausted retries");

    const outcome = await repo.retryFailed(taskId);
    expect(outcome).toEqual({ outcome: "retried", retriedRows: 1 });

    expect(await taskStatus(taskId)).toBe("pending");
    const t = await repo.getTask(taskId);
    expect(t?.epoch).toBe(1); // old runner is fenced out
    // Only the dead-lettered row came back; the done row was untouched.
    const pending = await rowRepo.fetchPendingRows(taskId, 3, 10);
    expect(pending.map((r) => r.rowIndex)).toEqual([1]);
  });
});
