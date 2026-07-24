import { errorStack } from "@crystallize/shared";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";

import { runnerConfig } from "../../../runner/config/runner.config";
import {
  RUNNER_FACTORY,
  type RunnerFactory,
  type RunnerService,
} from "../../../runner/services/runner.service";
import { dispatchConfig } from "../config/dispatch.config";

/** An inline run in flight: its service (for drain) and its completion. */
interface InlineRun {
  runner: RunnerService;
  done: Promise<void>;
}

/**
 * Threshold routing's inline path: run a light task inside the dispatcher
 * process — same semantics as the one-shot runner (claim fence, heartbeat,
 * drain), no process spawn. A fresh RunnerService per task, exactly like the
 * real process: its drain/stand-down state lives and dies with a single run.
 *
 * Isolated behind its own injectable (like RunnerLauncher) so the dispatcher's
 * claim loop can be unit-tested with a fake — no real execution. The runner
 * itself is built by RUNNER_FACTORY, so this path never hand-wires a
 * RunnerService: a change to its dependencies stays wired in ExecutionModule.
 */
@Injectable()
export class InlineRunner implements OnApplicationShutdown {
  private readonly log = new Logger(InlineRunner.name);
  private readonly active = new Map<string, InlineRun>();

  constructor(
    @Inject(RUNNER_FACTORY) private readonly runnerFactory: RunnerFactory,
    @Inject(runnerConfig.KEY)
    private readonly config: ConfigType<typeof runnerConfig>,
    @Inject(dispatchConfig.KEY)
    private readonly dispatch: ConfigType<typeof dispatchConfig>,
  ) {}

  /**
   * Light tasks currently running in this process — the claim loop stops
   * asking for `light` at DISPATCH_MAX_CONCURRENT_INLINE of them.
   */
  get activeCount(): number {
    return this.active.size;
  }

  /** Fire-and-track: the poll tick must not await a task's whole run. */
  run(taskId: string): void {
    // Narrower per-run concurrency than a dedicated runner process: every
    // inline run shares THIS process's pg pool, and the aggregate is what
    // the boot-time check in dispatch.config keeps under the pool size.
    const runner = this.runnerFactory({
      concurrency: this.dispatch.inlineRowConcurrency,
    });
    const done = runner
      .run(taskId)
      .catch((err) => {
        // The runner finalizes/stands down on its own; this only means the
        // run itself blew up. The sweeper will reclaim the task.
        this.log.error(`Inline task [${taskId}] crashed: ${errorStack(err)}`);
      })
      .finally(() => {
        this.active.delete(taskId);
      });
    this.active.set(taskId, { runner, done });
  }

  /**
   * SIGTERM: drain in-flight inline tasks exactly like a runner process —
   * including its drain deadline. A run stuck in an external call that
   * ignores the AbortSignal must not wedge the dispatcher's whole shutdown;
   * past the deadline we stop waiting and let the sweeper reclaim the task.
   */
  async onApplicationShutdown(): Promise<void> {
    for (const { runner } of this.active.values()) {
      runner.requestDrain();
    }
    const drained = Promise.all(
      [...this.active.values()].map((run) => run.done),
    ).then(() => true as const);
    const deadline = new Promise<false>((resolve) => {
      setTimeout(() => resolve(false), this.config.drainTimeoutMs).unref();
    });
    const finished = await Promise.race([drained, deadline]);
    if (!finished) {
      this.log.error(
        `Inline drain still not finished after ${this.config.drainTimeoutMs}ms — abandoning ${this.active.size} run(s) to the sweeper`,
      );
    }
  }
}
