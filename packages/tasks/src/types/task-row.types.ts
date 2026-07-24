export { TaskRowStatus } from "./task-row.enums";

/** A row still needing work, as returned by the resume query. */
export type PendingRow = {
  id: number;
  rowIndex: number;
  payload: Record<string, unknown>;
};

/** Per-status row counts for one task — the finalization aggregate. */
export type RowCounts = {
  total: number;
  done: number;
  failed: number;
  pending: number;
};

/** A dead-lettered row, as exposed by the DLQ inspection surface. */
export type DeadLetterRow = {
  rowIndex: number;
  payload: Record<string, unknown>;
  error: string | null;
  attempts: number;
};
