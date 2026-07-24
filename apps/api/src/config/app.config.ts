import { mapConfigOrThrow } from "@crystallize/shared";
import { DEFAULT_INLINE_THRESHOLD_ROWS } from "@crystallize/tasks";
import { registerAs } from "@nestjs/config";
import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  // Threshold routing (ADR 0006): bulk tasks at or under this row count are
  // published `light` and run inline in the dispatcher; above it they get a
  // runner process. Stamped at publish, so the routing of an already-queued
  // task never changes under it.
  INLINE_THRESHOLD_ROWS: z.coerce
    .number()
    .int()
    .positive()
    .default(DEFAULT_INLINE_THRESHOLD_ROWS),
  // Cap on an NDJSON request body. Enforced while streaming (never against a
  // declared Content-Length, which chunked encoding may omit or understate),
  // so an oversized job stops costing bytes the moment it crosses the line.
  NDJSON_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
});

export const appConfig = registerAs("app", () =>
  mapConfigOrThrow(schema, process.env, (data) => ({
    port: data.PORT,
    inlineThresholdRows: data.INLINE_THRESHOLD_ROWS,
    ndjsonMaxBytes: data.NDJSON_MAX_BYTES,
  })),
);
