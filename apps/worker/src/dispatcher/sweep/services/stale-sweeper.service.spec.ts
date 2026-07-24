import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { TaskRepository } from "@crystallize/tasks";
import type { SchedulerRegistry } from "@nestjs/schedule";

import { createMock } from "../../../../../../test-utils/mocks";
import { StaleSweeper } from "./stale-sweeper.service";

/**
 * Unit tests for the sweep tick — the SQL itself lives in TaskRepository and
 * is exercised end-to-end by the crash demo; here we verify the orchestration:
 * thresholds passed through, all three sweeps run, errors survived.
 */
describe("StaleSweeper.tick", () => {
  const repo = createMock<TaskRepository>();
  const registry = createMock<SchedulerRegistry>();
  const config = {
    sweepIntervalMs: 1000,
    staleAfterMs: 30_000,
    taskMaxRestarts: 3,
  };
  let service: StaleSweeper;

  beforeEach(() => {
    mock.clearAllMocks();
    repo.reclaimStale.mockResolvedValue(["task-a"]);
    repo.deadLetterStale.mockResolvedValue([]);
    repo.failStaleIngesting.mockResolvedValue([]);
    service = new StaleSweeper(repo, registry, config);
  });

  it("runs all three sweeps with the configured thresholds", async () => {
    await service.tick();
    expect(repo.reclaimStale).toHaveBeenCalledWith(30_000, 3);
    expect(repo.deadLetterStale).toHaveBeenCalledWith(30_000, 3);
    expect(repo.failStaleIngesting).toHaveBeenCalledWith(30_000);
  });

  it("survives a sweep failure without throwing (retries next tick)", async () => {
    repo.reclaimStale.mockRejectedValueOnce(new Error("connection refused"));
    await service.tick(); // must not reject
  });
});
