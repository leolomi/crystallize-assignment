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
});

export const appConfig = registerAs("app", () =>
  mapConfigOrThrow(schema, process.env, (data) => ({
    port: data.PORT,
    inlineThresholdRows: data.INLINE_THRESHOLD_ROWS,
  })),
);
