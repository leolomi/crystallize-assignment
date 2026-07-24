/**
 * The task-level enums of the contract — single source of truth for both the
 * pg enums (the Drizzle schema builds them via `tsEnumToPgEnum`, importing
 * THIS file directly) and every TS-side check. The row-ledger enum lives in
 * `task-row.enums.ts`.
 *
 * Keep this file a leaf (no imports): the database package reaches into it
 * from the schema, so any import here could turn into a package cycle at
 * module-initialization time.
 */

/**
 * The task lifecycle: `ingesting` while POST /tasks streams rows in (not
 * claimable), `pending` once published, `starting` when claimed, `running`
 * under a runner, then `completed`/`failed`.
 */
export enum TaskStatus {
  INGESTING = "ingesting",
  PENDING = "pending",
  STARTING = "starting",
  RUNNING = "running",
  COMPLETED = "completed",
  FAILED = "failed",
}

/**
 * The kind of work a task carries. One task = one kind (enforced at
 * ingestion); each kind maps to one RowProcessor.
 * `product_price_update` is a bulk idempotent upsert (many rows);
 * `catalogue_reindex` a single long-running rebuild.
 */
export enum TaskKind {
  PRODUCT_PRICE_UPDATE = "product_price_update",
  CATALOGUE_REINDEX = "catalogue_reindex",
}

/**
 * Threshold-routing classification, computed once at publish (see
 * `classifyWeight`): `light` tasks run inline in the dispatcher process,
 * `heavy` ones get a one-shot runner process of their own.
 */
export enum TaskWeight {
  LIGHT = "light",
  HEAVY = "heavy",
}
