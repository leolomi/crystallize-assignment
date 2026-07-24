import { customType } from "drizzle-orm/pg-core";

/**
 * A jsonb column that stores a real JSON object.
 *
 * Drizzle's built-in `jsonb()` runs `JSON.stringify` in its driver mapper, and
 * Bun's SQL driver then wraps that string again — the value lands as a jsonb
 * *string* (`jsonb_typeof = 'string'`), so `payload->>'id'` is null at the SQL
 * level. This custom type passes the object straight through in both directions
 * and lets Bun's driver serialize it, yielding a proper jsonb object.
 */
export const jsonbObject = customType<{
  data: Record<string, unknown>;
  driverData: unknown;
}>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    return value;
  },
  fromDriver(value) {
    return value as Record<string, unknown>;
  },
});
