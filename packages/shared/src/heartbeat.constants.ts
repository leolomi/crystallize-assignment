import { z } from "zod";

/**
 * Default cadence of the runner's liveness beat (HEARTBEAT_INTERVAL_MS).
 * Two apps read the same env var: the runner produces the beat, and the
 * dispatcher's sweeper validates STALE_AFTER_MS against it — shared so the
 * default can't drift between them.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;

/**
 * The single zod definition of that env var, embedded by both config schemas
 * (runner and sweep). One definition means the two processes cannot drift on
 * coercion, bounds, or default — the whole liveness contract hangs on them
 * agreeing about this value.
 */
export const heartbeatIntervalMsSchema = z.coerce
  .number()
  .int()
  .positive()
  .default(DEFAULT_HEARTBEAT_INTERVAL_MS);
