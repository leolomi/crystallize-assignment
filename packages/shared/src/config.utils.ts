import { z } from "zod";

/**
 * Validate raw config data (typically `process.env`) against a zod schema,
 * then map it to the app-facing shape. A schema violation throws at config
 * load — i.e. at process boot — with zod's readable error, instead of leaking
 * NaN/undefined into the runtime.
 */
export function mapConfigOrThrow<T, R>(
  schema: z.ZodType<T>,
  data: unknown,
  mapper: (data: T) => R,
): R {
  const result = schema.safeParse(data);

  if (!result.success) {
    throw new Error(z.prettifyError(result.error));
  }

  return mapper(result.data);
}
