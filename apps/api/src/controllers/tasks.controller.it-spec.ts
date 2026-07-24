import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DRIZZLE_DATABASE_PROVIDER,
  type DrizzleDatabaseProvider,
  schema,
} from "@crystallize/database";
import { TaskRowStatus, TaskStatus } from "@crystallize/tasks";
import { and, asc, eq } from "drizzle-orm";

import {
  closeTestApp,
  getJson,
  getTestApp,
  postJson,
  postNdjson,
  postNdjsonRaw,
} from "../../test-utils/test-app";

/**
 * Integration tests for the HTTP endpoints, on the shared test app (the real
 * bootstrap, random port, hit with fetch) against the throwaway docker
 * Postgres. Database setup/assertions go through the app's own Drizzle
 * provider — no second SQL client to keep in sync.
 */
let db: DrizzleDatabaseProvider;

const { task, taskRow } = schema;

describe("TasksController (integration)", () => {
  beforeAll(async () => {
    const app = await getTestApp();
    db = app.get(DRIZZLE_DATABASE_PROVIDER);
  });

  afterAll(async () => {
    await closeTestApp();
  });

  describe("POST /tasks/product-price-updates (NDJSON stream)", () => {
    it("streams payload lines (no envelope) and publishes the task", async () => {
      const res = await postNdjson("/tasks/product-price-updates", [
        { id: "n1", price: 9.99 },
        { id: "n2", price: 19.5 },
      ]);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: "product_price_update",
        status: "pending",
        totalRows: 2,
      });
      expect(res.body.id).toBeString();

      // The rows really are in the ledger, awaiting the dispatcher.
      const rows = await db
        .select({ rowIndex: taskRow.rowIndex })
        .from(taskRow)
        .where(eq(taskRow.taskId, res.body.id))
        .orderBy(asc(taskRow.rowIndex));
      expect(rows.map((r) => r.rowIndex)).toEqual([0, 1]);
    });

    it("rejects a non-NDJSON content type with an explicit 400", async () => {
      const res = await postJson("/tasks/product-price-updates", {
        rows: [{ id: "p1", price: 1 }],
      });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("application/x-ndjson");
    });

    it("rejects a malformed line with 400 naming the field", async () => {
      const res = await postNdjsonRaw(
        "/tasks/product-price-updates",
        '{"id":"p1"}',
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("price");
    });

    it("rejects an empty body with 400", async () => {
      const res = await postNdjsonRaw("/tasks/product-price-updates", "");
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("Empty job: no rows");
    });

    it("rejects invalid JSON with 400 and the offending line number", async () => {
      const res = await postNdjsonRaw(
        "/tasks/product-price-updates",
        '{"id":"p1","price":1}\n{not json',
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toBe("invalid JSON on line 2");
    });

    it("marks the half-ingested task failed on a mid-stream invalid line — never claimable", async () => {
      // The 400 body carries no task id, so diff the failed set around the call.
      const before = new Set(
        (await db.select({ id: task.id }).from(task)).map((t) => t.id),
      );

      const res = await postNdjsonRaw(
        "/tasks/product-price-updates",
        '{"id":"p1","price":1}\n{"id":"p2"}',
      );
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("line 2");

      const failed = (
        await db.select().from(task).where(eq(task.status, TaskStatus.FAILED))
      ).filter((t) => !before.has(t.id));
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toContain("line 2");
    });

    it("413s a body over the byte limit and fails the half-ingested task", async () => {
      const before = new Set(
        (await db.select({ id: task.id }).from(task)).map((t) => t.id),
      );

      // Valid lines throughout — the only violation is the cumulative size.
      const line = '{"id":"oversized","price":1}\n';
      const overLimit = Math.ceil((5 * 1024 * 1024) / line.length) + 1;
      const res = await postNdjsonRaw(
        "/tasks/product-price-updates",
        line.repeat(overLimit),
      );
      expect(res.status).toBe(413);
      expect(res.body.message).toContain("byte limit");

      const failed = (
        await db.select().from(task).where(eq(task.status, TaskStatus.FAILED))
      ).filter((t) => !before.has(t.id));
      expect(failed).toHaveLength(1);
      expect(failed[0].error).toContain("byte limit");
    });
  });

  describe("POST /tasks/catalogue-reindex", () => {
    it("accepts the payload as body (single-row job)", async () => {
      const res = await postJson("/tasks/catalogue-reindex", {
        catalogue: "products",
      });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        kind: "catalogue_reindex",
        status: "pending",
        totalRows: 1,
      });
    });

    it("rejects a malformed body with 400", async () => {
      const res = await postJson("/tasks/catalogue-reindex", { nope: true });
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("catalogue");
    });
  });

  describe("GET /docs", () => {
    it("serves the swagger document with one creation endpoint per kind", async () => {
      const res = await getJson("/docs-json");
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.paths)).toEqual(
        expect.arrayContaining([
          "/tasks/product-price-updates",
          "/tasks/catalogue-reindex",
          "/tasks/{id}",
        ]),
      );
    });
  });

  describe("dead letters & retry", () => {
    /** Create a 2-row task, then dead-letter row 0 and complete row 1. */
    async function makeFailedTask(): Promise<string> {
      const created = await postNdjson("/tasks/product-price-updates", [
        { id: "dl-0", price: 1 },
        { id: "dl-1", price: 2 },
      ]);
      const id = created.body.id as string;
      await db
        .update(taskRow)
        .set({
          status: TaskRowStatus.FAILED,
          attempts: 3,
          error: "injected failure",
        })
        .where(and(eq(taskRow.taskId, id), eq(taskRow.rowIndex, 0)));
      await db
        .update(taskRow)
        .set({ status: TaskRowStatus.DONE })
        .where(and(eq(taskRow.taskId, id), eq(taskRow.rowIndex, 1)));
      await db
        .update(task)
        .set({ status: TaskStatus.FAILED, error: "1 row(s) exhausted retries" })
        .where(eq(task.id, id));
      return id;
    }

    it("lists only the dead-lettered rows, with their error and attempts", async () => {
      const id = await makeFailedTask();
      const res = await getJson(`/tasks/${id}/dead-letters`);
      expect(res.status).toBe(200);
      expect(res.body.taskId).toBe(id);
      expect(res.body.rows).toEqual([
        {
          rowIndex: 0,
          payload: { id: "dl-0", price: 1 },
          error: "injected failure",
          attempts: 3,
        },
      ]);
    });

    it("404s dead-letters for an unknown task", async () => {
      const res = await getJson(`/tasks/${crypto.randomUUID()}/dead-letters`);
      expect(res.status).toBe(404);
    });

    it("400s dead-letters for a malformed (non-UUID) task id", async () => {
      const res = await getJson(
        `/tasks/runner-${crypto.randomUUID()}/dead-letters`,
      );
      expect(res.status).toBe(400);
    });

    it("replays a failed task: failed rows re-pended, done rows untouched, epoch bumped", async () => {
      const id = await makeFailedTask();
      const res = await postJson(`/tasks/${id}/retry`, undefined);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id, status: "pending", retriedRows: 1 });

      const [t] = await db.select().from(task).where(eq(task.id, id));
      expect(t).toMatchObject({
        status: "pending",
        error: null,
        restarts: 0,
        epoch: 1, // bumped: fences out any zombie of the previous run
      });
      const rows = await db
        .select({
          rowIndex: taskRow.rowIndex,
          status: taskRow.status,
          attempts: taskRow.attempts,
        })
        .from(taskRow)
        .where(eq(taskRow.taskId, id))
        .orderBy(asc(taskRow.rowIndex));
      expect(rows).toEqual([
        { rowIndex: 0, status: TaskRowStatus.PENDING, attempts: 0 },
        { rowIndex: 1, status: TaskRowStatus.DONE, attempts: 0 },
      ]);
    });

    it("409s a retry on a task that is not failed", async () => {
      const id = await makeFailedTask();
      await postJson(`/tasks/${id}/retry`, undefined); // -> pending
      const res = await postJson(`/tasks/${id}/retry`, undefined);
      expect(res.status).toBe(409);
    });

    it("400s a retry on a task that failed during ingestion (never published)", async () => {
      const [t] = await db
        .insert(task)
        .values({ status: TaskStatus.FAILED, error: "invalid JSON on line 2" })
        .returning({ id: task.id });
      const res = await postJson(`/tasks/${t.id}/retry`, undefined);
      expect(res.status).toBe(400);
      expect(res.body.message).toContain("submit the job again");
    });

    it("404s a retry for an unknown task", async () => {
      const res = await postJson(
        `/tasks/${crypto.randomUUID()}/retry`,
        undefined,
      );
      expect(res.status).toBe(404);
    });

    it("400s a retry for a malformed (non-UUID) task id", async () => {
      const res = await postJson(
        `/tasks/runner-${crypto.randomUUID()}/retry`,
        undefined,
      );
      expect(res.status).toBe(400);
    });
  });

  describe("GET /tasks/:id", () => {
    it("returns live status and progress for an ingested task", async () => {
      const created = await postNdjson("/tasks/product-price-updates", [
        { id: "g1", price: 1 },
        { id: "g2", price: 2 },
      ]);

      const res = await getJson(`/tasks/${created.body.id}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: created.body.id,
        kind: "product_price_update",
        status: "pending",
        totalRows: 2,
        processedRows: 0,
        progress: 0,
        error: null,
        runnerPid: null,
      });
    });

    it("computes progress from processed/total rows", async () => {
      const created = await postNdjson("/tasks/product-price-updates", [
        { id: "h1", price: 1 },
        { id: "h2", price: 2 },
      ]);

      // Simulate the runner's checkpoint: half the rows done.
      await db
        .update(task)
        .set({ processedRows: 1, status: TaskStatus.RUNNING })
        .where(eq(task.id, created.body.id));

      const res = await getJson(`/tasks/${created.body.id}`);
      expect(res.body.status).toBe("running");
      expect(res.body.progress).toBe(0.5);
    });

    it("returns 404 for an unknown task id", async () => {
      const missing = crypto.randomUUID();
      const res = await getJson(`/tasks/${missing}`);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe(`task ${missing} not found`);
    });

    it("returns 400 (not 500) for a malformed (non-UUID) task id", async () => {
      const res = await getJson(`/tasks/runner-${crypto.randomUUID()}`);
      expect(res.status).toBe(400);
    });
  });
});
