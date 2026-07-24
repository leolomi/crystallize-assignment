import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { schema } from "../drizzle";

export type DrizzleDatabaseProvider = BunSQLDatabase<typeof schema>;
