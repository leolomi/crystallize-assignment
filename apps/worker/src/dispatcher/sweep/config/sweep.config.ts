import {
  heartbeatIntervalMsSchema,
  mapConfigOrThrow,
} from "@crystallize/shared";
import { registerAs } from "@nestjs/config";
import { z } from "zod";

const schema = z
  .object({
    // How often the sweeper scans for stale claims.
    SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
    // Silence threshold: a claimed task whose heartbeat is older than this is
    // presumed dead and reclaimed.
    STALE_AFTER_MS: z.coerce.number().int().positive().default(30_000),
    // Restart budget: past it, a stale task is dead-lettered, not re-pended.
    TASK_MAX_RESTARTS: z.coerce.number().int().positive().default(3),
    // The runner's beat cadence (same env var the runner reads, through the
    // same shared schema) — only used here to validate that the silence
    // threshold tolerates missed beats.
    HEARTBEAT_INTERVAL_MS: heartbeatIntervalMsSchema,
  })
  .refine((data) => data.STALE_AFTER_MS >= 3 * data.HEARTBEAT_INTERVAL_MS, {
    message:
      "STALE_AFTER_MS must be at least 3x HEARTBEAT_INTERVAL_MS, otherwise a " +
      "single missed beat gets a live runner reclaimed",
  });

export const sweepConfig = registerAs("sweep", () =>
  mapConfigOrThrow(schema, process.env, (data) => ({
    sweepIntervalMs: data.SWEEP_INTERVAL_MS,
    staleAfterMs: data.STALE_AFTER_MS,
    taskMaxRestarts: data.TASK_MAX_RESTARTS,
  })),
);
