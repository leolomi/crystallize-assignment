import { errorMessage } from "@crystallize/shared";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";

import { dispatchConfig } from "../config/dispatch.config";

/**
 * Launches one-shot runner processes. Isolated behind its own injectable so the
 * dispatcher's claim loop can be unit-tested with a mock launcher — no real
 * processes forked.
 *
 * The runner must stay a real OS process (Bun.spawn), not a `new Worker()`
 * thread or a scheduled in-process task: the process boundary is what lets a
 * runner be killed / crash / deploy independently of the dispatcher — the
 * exact failure modes the design is built around.
 */
@Injectable()
export class RunnerLauncher {
  private readonly log = new Logger(RunnerLauncher.name);
  private readonly live = new Set<number>();

  constructor(
    @Inject(dispatchConfig.KEY)
    private readonly config: ConfigType<typeof dispatchConfig>,
  ) {}

  /**
   * Runner processes this dispatcher spawned that are still alive — the
   * dispatcher's claim loop stops at DISPATCH_MAX_CONCURRENT_RUNNERS of them.
   * Local by design: each dispatcher bounds its own children; the queue itself
   * needs no global cap, unclaimed tasks just stay pending.
   */
  get activeCount(): number {
    return this.live.size;
  }

  launch(taskId: string): void {
    let proc: Bun.Subprocess;
    try {
      proc = this.spawn(taskId);
    } catch (err) {
      // A failed spawn (missing entrypoint, fork limit) must not abort the
      // dispatcher's whole tick — the other claims of the loop still deserve
      // their runner. The task itself needs no repair here: it stays
      // `starting` with no heartbeat, so the sweeper re-pends it.
      this.log.error(
        `Failed to spawn runner for task [${taskId}] (${errorMessage(err)}) — leaving it to the sweeper`,
      );
      return;
    }
    this.live.add(proc.pid);
    // Don't let the subprocess keep the dispatcher's event loop alive; the
    // runner's lifetime is intentionally independent of ours.
    proc.unref();
    this.log.log(`Spawned runner (pid ${proc.pid}) for task [${taskId}]`);
  }

  private spawn(taskId: string): Bun.Subprocess {
    return Bun.spawn({
      cmd: ["bun", "run", this.config.runnerEntrypoint, taskId],
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        // Size the child's pg pool for a runner, not a service: N runners at
        // the dispatcher-wide default would blow the max_connections budget
        // (see RUNNER_DB_MAX_CONNECTIONS in dispatch.config).
        DB_MAX_CONNECTIONS: String(this.config.runnerDbMaxConnections),
      },
      onExit: (exited, exitCode, signalCode) => {
        this.live.delete(exited.pid);
        const outcome =
          signalCode !== null ? `signal ${signalCode}` : `code ${exitCode}`;
        this.log.log(`Runner for task [${taskId}] exited (${outcome})`);
      },
    });
  }
}
