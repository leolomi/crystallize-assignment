import { errorMessage } from "@crystallize/shared";
import { TaskRepository, TaskWeight } from "@crystallize/tasks";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { match } from "ts-pattern";
import { dispatchConfig } from "../config/dispatch.config";
import { InlineRunner } from "./inline-runner.service";
import { RunnerLauncher } from "./runner-launcher.service";

const POLL_INTERVAL_NAME = "dispatch-poll";

/**
 * The thin dispatcher — a Postgres-polling queue consumer. Each tick drains
 * the queue: atomically claim the oldest pending task (pending -> starting,
 * via FOR UPDATE SKIP LOCKED) and route it by weight (threshold routing,
 * ADR 0006): heavy -> spawn a one-shot runner process (RunnerLauncher),
 * light -> run inline in this process (InlineRunner). Repeat until nothing
 * claimable remains.
 *
 * Because the claim is the delivery mechanism itself, there is nothing to ack
 * and no dual-write: a task committed by the API is *by construction* visible
 * to the next poll. Multiple dispatchers can run concurrently — SKIP LOCKED
 * partitions the queue between them for free.
 *
 * Lifecycle is fully Nest-managed: the poll interval is registered with the
 * SchedulerRegistry on bootstrap (registry rather than @Interval because the
 * cadence is config-driven, and decorator arguments are static) and torn down
 * by the registry on shutdown.
 */
@Injectable()
export class Dispatcher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly log = new Logger(Dispatcher.name);
  private ticking = false;

  constructor(
    private readonly repo: TaskRepository,
    private readonly launcher: RunnerLauncher,
    private readonly inline: InlineRunner,
    private readonly registry: SchedulerRegistry,
    @Inject(dispatchConfig.KEY)
    private readonly config: ConfigType<typeof dispatchConfig>,
  ) {}

  onApplicationBootstrap() {
    const interval = setInterval(
      () => void this.tick(),
      this.config.pollIntervalMs,
    );
    this.registry.addInterval(POLL_INTERVAL_NAME, interval);
    this.log.log(
      `Polling for pending tasks every ${this.config.pollIntervalMs}ms`,
    );
    void this.tick(); // immediate first sweep — pick up any backlog
  }

  onApplicationShutdown(signal?: string) {
    this.log.warn(`Stopping poll (${signal ?? "shutdown"})`);
    // The SchedulerRegistry clears its intervals on shutdown; spawned tasks
    // belong to their (independent) runner processes, and in-flight inline
    // tasks are drained by InlineRunner's own shutdown hook.
  }

  /**
   * One poll tick: claim + route until the queue is drained or every lane is
   * at capacity. Non-reentrant. Claims stop BEFORE a cap is exceeded — the
   * claim only asks for weights with a free slot, so a task we cannot start
   * stays `pending` for a later tick, not claimed with no execution behind it.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (;;) {
        const weights = this.claimableWeights();
        if (weights.length === 0) {
          this.log.debug(
            `Caps reached (${this.config.maxConcurrentRunners} runners, ${this.config.maxConcurrentInline} inline) — not claiming this tick`,
          );
          return;
        }
        const claim = await this.repo.claimNextPending(weights);
        if (!claim) return;

        this.log.log(`Claimed task [${claim.id}] (${claim.weight})`);

        match(claim.weight)
          .with(TaskWeight.LIGHT, () => this.inline.run(claim.id))
          .with(TaskWeight.HEAVY, () => this.launcher.launch(claim.id))
          .exhaustive();
      }
    } catch (err) {
      this.log.error(`Poll failed: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** The weights this dispatcher can execute right now, one lane per cap. */
  private claimableWeights(): TaskWeight[] {
    const weights: TaskWeight[] = [];
    if (this.inline.activeCount < this.config.maxConcurrentInline) {
      weights.push(TaskWeight.LIGHT);
    }
    if (this.launcher.activeCount < this.config.maxConcurrentRunners) {
      weights.push(TaskWeight.HEAVY);
    }
    return weights;
  }
}
