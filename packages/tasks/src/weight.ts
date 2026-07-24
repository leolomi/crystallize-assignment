import { match } from "ts-pattern";
import { TaskKind, TaskWeight } from "./types/task.enums";

/** Default row-count threshold at or under which a bulk task is `light`. */
export const DEFAULT_INLINE_THRESHOLD_ROWS = 1000;

/**
 * Classify a task for threshold routing, at publish time.
 *
 * Kind-aware on purpose: row count is only a duration proxy for row-shaped
 * kinds. A catalogue re-index is ONE row but long by nature — it must never
 * run inline in the dispatcher, so it is heavy regardless of its row count.
 */
export function classifyWeight(
  kind: TaskKind,
  totalRows: number,
  inlineThresholdRows: number,
): TaskWeight {
  return match(kind)
    .with(TaskKind.CATALOGUE_REINDEX, () => TaskWeight.HEAVY)
    .with(TaskKind.PRODUCT_PRICE_UPDATE, () =>
      totalRows <= inlineThresholdRows ? TaskWeight.LIGHT : TaskWeight.HEAVY,
    )
    .exhaustive();
}
