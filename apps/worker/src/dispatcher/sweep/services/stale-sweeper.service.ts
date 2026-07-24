import { errorMessage } from "@crystallize/shared";
import { TaskRepository } from "@crystallize/tasks";
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import type { ConfigType } from "@nestjs/config";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sweepConfig } from "../config/sweep.config";

const SWEEP_INTERVAL_NAME = "stale-sweep";

/**
 * The stale-runner sweeper — the recovery half of the dispatcher. Each tick it
 * looks for claims whose heartbeat went silent and, in one atomic UPDATE per
 * category:
 *
 *   - re-pends stale tasks (restart budget permitting) and bumps their epoch,
 *     so the NORMAL claim path re-fires them and the old runner — if it was
 *     only frozen, not dead — is fenced out;
 *   - dead-letters stale tasks that burned their restart budget (poison jobs
 *     must not crash-loop forever);
 *   - fails tasks stuck `ingesting` (API died mid-stream — never claimable,
 *     so invisible to the reclaim above).
 *
 * It never spawns or repairs anything itself: recovery IS re-publication.
 * Multiple dispatchers can sweep concurrently — the UPDATEs re-check their
 * WHERE under the row lock, like the claim.
 */
@Injectable()
export class StaleSweeper implements OnApplicationBootstrap {
  private readonly log = new Logger(StaleSweeper.name);
  private ticking = false;

  constructor(
    private readonly repo: TaskRepository,
    private readonly registry: SchedulerRegistry,
    @Inject(sweepConfig.KEY)
    private readonly config: ConfigType<typeof sweepConfig>,
  ) {}

  onApplicationBootstrap() {
    const interval = setInterval(
      () => void this.tick(),
      this.config.sweepIntervalMs,
    );
    this.registry.addInterval(SWEEP_INTERVAL_NAME, interval);
    this.log.log(
      `Sweeping every ${this.config.sweepIntervalMs}ms (stale after ${this.config.staleAfterMs}ms, max ${this.config.taskMaxRestarts} restarts)`,
    );
  }

  /** One sweep tick. Non-reentrant; a failed tick just retries next time. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const { staleAfterMs, taskMaxRestarts } = this.config;

      const reclaimed = await this.repo.reclaimStale(
        staleAfterMs,
        taskMaxRestarts,
      );
      for (const id of reclaimed) {
        this.log.warn(`Reclaimed stale task [${id}] -> pending (will re-fire)`);
      }

      const deadLettered = await this.repo.deadLetterStale(
        staleAfterMs,
        taskMaxRestarts,
      );
      for (const id of deadLettered) {
        this.log.error(
          `Dead-lettered stale task [${id}]: restart budget exhausted`,
        );
      }

      const stalled = await this.repo.failStaleIngesting(staleAfterMs);
      for (const id of stalled) {
        this.log.error(`Failed stalled-ingestion task [${id}]`);
      }
    } catch (err) {
      this.log.error(`Sweep failed: ${errorMessage(err)}`);
    } finally {
      this.ticking = false;
    }
  }
}
