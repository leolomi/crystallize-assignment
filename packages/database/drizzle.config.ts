import { defineConfig } from "drizzle-kit";

// drizzle-kit runs outside the app runtime, so we read process.env directly
// here (same vars as src/db.config.ts) rather than importing the runtime module.
export default defineConfig({
  dialect: "postgresql",
  schema: "./drizzle/schema/index.ts",
  out: "./drizzle/migrations",
  casing: "snake_case",
  dbCredentials: {
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USERNAME ?? "postgres",
    password: process.env.DB_PASSWORD ?? "postgres",
    database: process.env.DB_NAME ?? "bulk_runner",
    ssl: false,
  },
});
