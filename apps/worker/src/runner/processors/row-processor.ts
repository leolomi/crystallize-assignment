import type { TaskKind, TaskPayloads } from "@crystallize/tasks";
import { Inject, Injectable } from "@nestjs/common";

/**
 * A row processor encapsulates the effect for one task kind. Effects land in the
 * external store (Mongo) while the row's `pending -> done` flip is a separate
 * Postgres commit, so every effect MUST be idempotent: a crash between the two
 * replays the row, and re-applying has to converge, not compound. In practice
 * each payload carries absolute state (a price, a catalogue name) — never a
 * delta (ADR 0003).
 *
 * Processors receive an AbortSignal so a long-running effect can be cut short on
 * graceful shutdown.
 *
 * Payloads are typed per kind (`TaskPayloads[K]`) — their shape is validated
 * once, at ingestion, so processors can trust it.
 */
export interface RowProcessor<K extends TaskKind = TaskKind> {
  readonly kind: K;
  apply(payload: TaskPayloads[K], signal: AbortSignal): Promise<void>;
}

export const ROW_PROCESSORS = Symbol("ROW_PROCESSORS");

@Injectable()
export class RowProcessorRegistry {
  private readonly byKind = new Map<TaskKind, RowProcessor>();

  constructor(@Inject(ROW_PROCESSORS) processors: RowProcessor[]) {
    for (const processor of processors)
      this.byKind.set(processor.kind, processor);
  }

  get(kind: TaskKind): RowProcessor {
    const processor = this.byKind.get(kind);
    if (!processor)
      throw new Error(`no row processor registered for kind "${kind}"`);
    return processor;
  }
}
