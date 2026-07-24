import { z } from "zod";

import { TaskKind, type TaskStatus, type TaskWeight } from "./task.enums";

export { TaskKind, TaskStatus, TaskWeight } from "./task.enums";

/**
 * One zod schema per kind — the single runtime definition of each payload's
 * shape, shared by both ingestion paths (JSON body and NDJSON lines). The
 * static types below are inferred from these.
 */
export const taskPayloadSchemas = {
  [TaskKind.PRODUCT_PRICE_UPDATE]: z.object({
    id: z.string(),
    price: z.number(),
  }),
  [TaskKind.CATALOGUE_REINDEX]: z.object({ catalogue: z.string() }),
} as const;

export type ProductPriceUpdatePayload = z.infer<
  (typeof taskPayloadSchemas)[TaskKind.PRODUCT_PRICE_UPDATE]
>;
export type CatalogueReindexPayload = z.infer<
  (typeof taskPayloadSchemas)[TaskKind.CATALOGUE_REINDEX]
>;

export type TaskPayloads = {
  [TaskKind.PRODUCT_PRICE_UPDATE]: ProductPriceUpdatePayload;
  [TaskKind.CATALOGUE_REINDEX]: CatalogueReindexPayload;
};

export type TaskPayload = TaskPayloads[TaskKind];

/**
 * The domain view of a task — deliberately hand-written rather than
 * `typeof schema.task.$inferSelect`, so the domain package (and everything that
 * consumes it: controllers, DTOs, the runner) does not take a structural
 * dependency on the Drizzle schema. The persistence side maps its rows onto
 * this shape in TaskRepository; that mapper is the single ORM boundary and its
 * signature is what catches a schema/domain drift at compile time.
 */
export type TaskRecord = {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  weight: TaskWeight;
  totalRows: number;
  processedRows: number;
  error: string | null;
  runnerPid: number | null;
  heartbeatAt: Date | null;
  restarts: number;
  epoch: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

/** Identifies a runner's claim on a task: writes only land while the epoch holds. */
export type TaskOwner = {
  taskId: string;
  epoch: number;
};

/** A successful claim: the task id plus its routing weight. */
export type ClaimedTask = { id: string; weight: TaskWeight };

export type RetryOutcome =
  | { outcome: "retried"; retriedRows: number }
  | { outcome: "not_found" }
  | { outcome: "not_failed" }
  | { outcome: "never_published" };
