import { fileURLToPath } from "node:url";
import { mapConfigOrThrow } from "@crystallize/shared";
import { registerAs } from "@nestjs/config";
import { z } from "zod";

// The dispatcher spawns heavy tasks' runners as OS processes, so it needs the
// runner's entrypoint — the worker app's other main, a sibling subtree (the
// two deploy together by construction). Override when the layout differs.
const DEFAULT_RUNNER_ENTRYPOINT = fileURLToPath(
  new URL("../../../runner/main.ts", import.meta.url),
);

const schema = z
  .object({
    // How often the dispatcher polls Postgres for claimable tasks.
    DISPATCH_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
    // Cap on runner processes THIS dispatcher keeps alive at once: a burst
    // of pending tasks must not fork a process (and its DB connections) per
    // task. Tasks beyond the cap stay pending; the next tick claims them as
    // slots free. The default fits the connection budget on a stock
    // Postgres: api (20) + dispatcher (20) + 3 x RUNNER_DB_MAX_CONNECTIONS
    // (18) = 94 <= max_connections (100). Raising it means raising
    // max_connections (or fronting Postgres with a pooler).
    DISPATCH_MAX_CONCURRENT_RUNNERS: z.coerce
      .number()
      .int()
      .positive()
      .default(3),
    // Cap on light tasks run inline (threshold routing): they share the
    // dispatcher's process, so this bounds their memory/CPU footprint.
    DISPATCH_MAX_CONCURRENT_INLINE: z.coerce
      .number()
      .int()
      .positive()
      .default(4),
    // In-flight rows per INLINE run. Deliberately lower than
    // RUNNER_CONCURRENCY: every inline run shares the dispatcher's single pg
    // pool, so the aggregate (inline cap x this, plus claim/sweep/heartbeat
    // overhead) must stay under DB_MAX_CONNECTIONS — the same
    // pool-starvation wedge as the runner's, checked at boot below. Light
    // tasks are small by definition; they don't need a wide lane.
    INLINE_ROW_CONCURRENCY: z.coerce.number().int().positive().default(4),
    RUNNER_ENTRYPOINT: z.string().default(DEFAULT_RUNNER_ENTRYPOINT),
    // Pg pool size handed to each spawned runner (overrides
    // DB_MAX_CONNECTIONS in the child env). Two hard constraints, in
    // tension:
    //   - it must cover the runner's own parallelism (RUNNER_CONCURRENCY
    //     row flips + heartbeat + progress): sized below it, runners wedged
    //     under sustained multi-runner load (client-side pool starvation,
    //     observed at pool 5 / concurrency 16 and discriminated A/B against
    //     pool 20);
    //   - the aggregate must fit Postgres:
    //       api + dispatchers (DB_MAX_CONNECTIONS each)
    //         + runners (DISPATCH_MAX_CONCURRENT_RUNNERS x this, per
    //           dispatcher)
    //       <= max_connections (default 100).
    // Default 18 = RUNNER_CONCURRENCY (16) + heartbeat + progress; the
    // budget is balanced by the runner cap above. runner.config re-checks
    // the first constraint at boot.
    RUNNER_DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(18),
    // The dispatcher's own pg pool (same env var dbConfig reads — validated
    // here only for the cross-check below).
    DB_MAX_CONNECTIONS: z.coerce.number().int().positive().default(20),
  })
  .refine(
    (data) =>
      data.DB_MAX_CONNECTIONS >=
      data.DISPATCH_MAX_CONCURRENT_INLINE * data.INLINE_ROW_CONCURRENCY + 4,
    {
      message:
        "DB_MAX_CONNECTIONS must cover the inline lane " +
        "(DISPATCH_MAX_CONCURRENT_INLINE x INLINE_ROW_CONCURRENCY) plus the " +
        "claim/sweep/heartbeat overhead (+4): a smaller pool wedges inline " +
        "runs under sustained load",
    },
  );

export const dispatchConfig = registerAs("dispatch", () =>
  mapConfigOrThrow(schema, process.env, (data) => ({
    pollIntervalMs: data.DISPATCH_POLL_INTERVAL_MS,
    maxConcurrentRunners: data.DISPATCH_MAX_CONCURRENT_RUNNERS,
    maxConcurrentInline: data.DISPATCH_MAX_CONCURRENT_INLINE,
    inlineRowConcurrency: data.INLINE_ROW_CONCURRENCY,
    runnerEntrypoint: data.RUNNER_ENTRYPOINT,
    runnerDbMaxConnections: data.RUNNER_DB_MAX_CONNECTIONS,
  })),
);
