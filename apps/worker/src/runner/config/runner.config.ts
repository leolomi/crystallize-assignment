import {
  heartbeatIntervalMsSchema,
  mapConfigOrThrow,
} from "@crystallize/shared";
import { registerAs } from "@nestjs/config";
import { z } from "zod";

const schema = z
  .object({
    // Bounded concurrency: how many rows are in-flight at once.
    RUNNER_CONCURRENCY: z.coerce.number().int().positive().default(16),
    // How many pending rows we pull from the DB per page.
    RUNNER_BATCH_SIZE: z.coerce.number().int().positive().default(200),
    // A row is dead-lettered after this many failed attempts.
    ROW_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    // Pause before refetching a page that recorded failures, so a failing
    // row's attempts are spaced out instead of burned in an immediate hot
    // loop.
    ROW_RETRY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(1000),
    // Catalogue re-index paging: products read from Postgres per page, and a
    // throttle between pages. The delay keeps the long-op demo observable
    // (and its SIGTERM-interruption window comfortable); 0 disables it.
    REINDEX_PAGE_SIZE: z.coerce.number().int().positive().default(1000),
    REINDEX_PAGE_DELAY_MS: z.coerce.number().int().nonnegative().default(250),
    // Liveness proof cadence (see RunnerService.startHeartbeat). The
    // sweeper's STALE_AFTER_MS must be a comfortable multiple of this; the
    // shared schema keeps both readers of this env var agreeing on its
    // definition.
    HEARTBEAT_INTERVAL_MS: heartbeatIntervalMsSchema,
    // Drain deadline: on SIGTERM/SIGINT the runner stops taking rows and
    // waits for the in-flight ones — but a row stuck in an external call
    // that ignores the AbortSignal must not hold the process until the
    // orchestrator SIGKILLs it. Past this deadline the process exits;
    // pending rows resume next run.
    RUNNER_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    // The pg pool of THIS process (same env var dbConfig reads — validated
    // here only for the cross-check below, like HEARTBEAT_INTERVAL_MS in
    // sweep.config).
    DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20),
  })
  .refine((data) => data.DB_MAX_CONNECTIONS >= data.RUNNER_CONCURRENCY + 2, {
    message:
      "DB_MAX_CONNECTIONS must cover RUNNER_CONCURRENCY plus the heartbeat " +
      "and progress writes (concurrency + 2): a pool smaller than the " +
      "runner's own parallelism wedges it under sustained load",
  });

export const runnerConfig = registerAs("runner", () =>
  mapConfigOrThrow(schema, process.env, (data) => ({
    concurrency: data.RUNNER_CONCURRENCY,
    batchSize: data.RUNNER_BATCH_SIZE,
    maxAttempts: data.ROW_MAX_ATTEMPTS,
    retryBackoffMs: data.ROW_RETRY_BACKOFF_MS,
    reindexPageSize: data.REINDEX_PAGE_SIZE,
    reindexPageDelayMs: data.REINDEX_PAGE_DELAY_MS,
    heartbeatIntervalMs: data.HEARTBEAT_INTERVAL_MS,
    drainTimeoutMs: data.RUNNER_DRAIN_TIMEOUT_MS,
  })),
);
