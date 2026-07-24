import { mapConfigOrThrow } from "@crystallize/shared";
import { registerAs } from "@nestjs/config";
import { z } from "zod";

// drizzle.config.ts reads the same DB_* vars directly — drizzle-kit runs
// outside the Nest runtime.
const schema = z.object({
  DB_HOST: z.string().default("localhost"),
  DB_PORT: z.coerce.number().int().positive().default(5432),
  DB_USERNAME: z.string().default("postgres"),
  DB_PASSWORD: z.string().default("postgres"),
  DB_NAME: z.string().default("bulk_runner"),
  DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20),
});

export const dbConfig = registerAs("db", () =>
  mapConfigOrThrow(schema, process.env, (data) => ({
    host: data.DB_HOST,
    port: data.DB_PORT,
    username: data.DB_USERNAME,
    password: data.DB_PASSWORD,
    database: data.DB_NAME,
    maxConnections: data.DB_MAX_CONNECTIONS,
  })),
);
