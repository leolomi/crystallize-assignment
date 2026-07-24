import { mapConfigOrThrow } from "@crystallize/shared";
import { registerAs } from "@nestjs/config";
import { z } from "zod";

const schema = z.object({
  // Mongo — the business store: `products` and its search projection
  // `catalogue_index`. Only the runner connects (matches
  // docker/docker-compose.yml).
  MONGO_HOST: z.string().default("localhost"),
  MONGO_PORT: z.coerce.number().int().positive().default(27017),
  MONGO_DB: z.string().default("bulk_runner"),
  // Hard ceiling on any single Mongo operation. Without it a lost response
  // (socket wedged mid-op) waits FOREVER: the row never settles, the runner
  // freezes with its heartbeat still beating — a live zombie the sweeper
  // will never reclaim, because liveness proves the process, not progress.
  // Bounded, a wedged op becomes a plain row failure and the retry /
  // dead-letter machinery owns it. Observed for real under a connection
  // storm (3 runners + reindex): see the chaos-test findings.
  MONGO_OP_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export const mongoConfig = registerAs("mongo", () =>
  mapConfigOrThrow(schema, process.env, (data) => ({
    url: `mongodb://${data.MONGO_HOST}:${data.MONGO_PORT}`,
    dbName: data.MONGO_DB,
    opTimeoutMs: data.MONGO_OP_TIMEOUT_MS,
  })),
);
