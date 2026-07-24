import type { Params as PinoParams } from "pino-nestjs";

/**
 * Shared pino config for every process. Each app calls it with its own service name so every log line
 * carries its process of origin — useful when api/dispatcher/runner interleave.
 *
 * - dev: pino-pretty, single line, colorized
 * - prod: structured JSON
 * - test: silent (bun test sets NODE_ENV=test)
 *
 * The HTTP-specific options (request logging, request-id, per-status levels)
 * only apply to HTTP apps; application contexts (dispatcher, runner) just get
 * the structured logger.
 */
export function pinoLoggerConfig(serviceName: string): PinoParams {
  const pretty = process.env.NODE_ENV !== "production";

  return {
    pinoHttp: {
      name: serviceName,
      level: process.env.NODE_ENV === "test" ? "silent" : "info",
      // Correlate every log line of a request: reuse the caller's
      // x-request-id, otherwise mint one and echo it back.
      genReqId: (req, res) => {
        const existingId = req.id ?? req.headers["x-request-id"];
        if (existingId) return existingId as string;
        const id = Bun.randomUUIDv7();
        res.setHeader("X-Request-Id", id);
        return id;
      },
      transport: pretty
        ? {
            target: "pino-pretty",
            options: {
              colorize: true,
              singleLine: true,
              ignore: "pid,hostname,req,res",
            },
          }
        : undefined,
      formatters: {
        level: (label: string) => ({ level: label }),
      },
      customLogLevel: (_req, res, error) => {
        if (res.statusCode >= 500 || error) return "error";
        if (res.statusCode >= 400) return "warn";
        return "info";
      },
      customReceivedMessage: (req) => `Incoming [${req.method}] [${req.url}]`,
      customSuccessMessage: (req, res) =>
        `[${req.method}] [${req.url}] - [${res.statusCode}]`,
      customErrorMessage: (_req, _res, error) => error.message,
      base: { service: serviceName },
    },
  } satisfies PinoParams;
}
