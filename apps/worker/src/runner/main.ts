/**
 * The one-shot runner.
 * Usage: bun run runner <taskId>   (or: bun run apps/worker/src/runner/main.ts <taskId>)
 *
 * Processes a task's pending rows with bounded concurrency, checkpoints, and
 * exits. Re-running the same task id resumes it. On SIGTERM (or SIGINT — the
 * dev Ctrl-C must behave like the deploy path) it drains in-flight rows and
 * exits cleanly, leaving the task resumable (the rolling-deploy case).
 */
import "reflect-metadata";
import { createHeadlessContext, errorStack } from "@crystallize/shared";
import { Logger } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";

import { runnerConfig } from "./config/runner.config";
import { RunnerModule } from "./runner.module";
import { RUNNER_FACTORY, type RunnerFactory } from "./services/runner.service";

async function bootstrap() {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("Usage: bun run runner <taskId>");
    process.exit(1);
  }
  const log = new Logger(`Runner-${taskId}`);

  const ctx = await createHeadlessContext(RunnerModule);
  // One runner for this process, built by the container-owned factory. Reused
  // for both the signal handlers and the run — resolving twice would be two
  // different instances, so the handlers must close over this exact one.
  const runner = ctx.get<RunnerFactory>(RUNNER_FACTORY)();

  // Graceful shutdown: a signal asks the runner to drain — run() finishes its
  // in-flight rows and returns normally, we do NOT force-exit right away. (No
  // enableShutdownHooks either: it would close the context mid-drain.) The
  // deadline is the escape hatch: a row stuck in an external call that
  // ignores the AbortSignal would otherwise hold the process until the
  // orchestrator SIGKILLs it — past the deadline we exit non-zero, and the
  // still-pending rows resume on the next run.
  const { drainTimeoutMs } = ctx.get<ConfigType<typeof runnerConfig>>(
    runnerConfig.KEY,
  );
  const drain = (signal: string) => {
    runner.requestDrain();
    setTimeout(() => {
      log.error(
        `Drain still not finished ${drainTimeoutMs}ms after ${signal} — exiting (pending rows resume on the next run)`,
      );
      process.exit(1);
    }, drainTimeoutMs).unref(); // the watchdog must never hold the process open
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));

  try {
    await runner.run(taskId);
    await ctx.close();
    process.exit(0);
  } catch (err) {
    log.error(`Runner crashed: ${errorStack(err)}`);
    await ctx.close().catch(() => {});
    process.exit(1);
  }
}

bootstrap().catch((err) => {
  console.error("Runner failed to start:", err);
  process.exit(1);
});
