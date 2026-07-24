import { beforeEach, describe, expect, it, mock } from "bun:test";
import {
  type ClaimedTask,
  type TaskRepository,
  TaskWeight,
} from "@crystallize/tasks";
import type { SchedulerRegistry } from "@nestjs/schedule";

import { createMock } from "../../../../../../test-utils/mocks";
import { Dispatcher } from "./dispatcher.service";
import type { InlineRunner } from "./inline-runner.service";
import type { RunnerLauncher } from "./runner-launcher.service";

/**
 * Unit tests for the claim loop and its threshold routing — possible because
 * both execution side effects live behind injectables (RunnerLauncher for the
 * spawn, InlineRunner for the inline path). Plain constructor injection with
 * createMock deps; no Nest context, no real processes.
 */
describe("Dispatcher.tick", () => {
  const repo = createMock<TaskRepository>();
  const registry = createMock<SchedulerRegistry>();
  let launched: string[];
  let inlined: string[];
  let service: Dispatcher;

  function makeService(overrides?: {
    maxConcurrentRunners?: number;
    maxConcurrentInline?: number;
  }) {
    return new Dispatcher(repo, makeLauncher(), makeInline(), registry, {
      pollIntervalMs: 1000,
      maxConcurrentRunners: overrides?.maxConcurrentRunners ?? 100,
      maxConcurrentInline: overrides?.maxConcurrentInline ?? 100,
      runnerEntrypoint: "unused-in-tests",
      runnerDbMaxConnections: 5,
      inlineRowConcurrency: 4,
    });
  }

  beforeEach(() => {
    mock.clearAllMocks();
    launched = [];
    inlined = [];
    service = makeService();
  });

  /**
   * Behavioral fakes, deliberately NOT createMock: the contract under test is
   * the `activeCount` getters growing as work is recorded — createMock's proxy
   * caches a property's first read, which would freeze the counts.
   */
  function makeLauncher(): RunnerLauncher {
    return {
      get activeCount() {
        return launched.length;
      },
      launch: (taskId: string) => void launched.push(taskId),
    } as unknown as RunnerLauncher;
  }

  function makeInline(): InlineRunner {
    return {
      get activeCount() {
        return inlined.length;
      },
      run: (taskId: string) => void inlined.push(taskId),
    } as unknown as InlineRunner;
  }

  /**
   * Wire the claim mock to drain the given queue, honouring the weight filter
   * like the real SQL does: the oldest task whose weight was asked for.
   */
  function queueOf(...tasks: ClaimedTask[]) {
    const remaining = [...tasks];
    repo.claimNextPending.mockImplementation(async (weights: TaskWeight[]) => {
      const idx = remaining.findIndex((t) => weights.includes(t.weight));
      return idx === -1 ? null : remaining.splice(idx, 1)[0];
    });
  }

  const heavy = (id: string): ClaimedTask => ({
    id,
    weight: TaskWeight.HEAVY,
  });
  const light = (id: string): ClaimedTask => ({
    id,
    weight: TaskWeight.LIGHT,
  });

  it("drains the queue, routing by weight: heavy spawned, light inlined", async () => {
    queueOf(heavy("task-a"), light("task-b"), heavy("task-c"));
    await service.tick();
    expect(launched).toEqual(["task-a", "task-c"]);
    expect(inlined).toEqual(["task-b"]);
  });

  it("does nothing when the queue is empty", async () => {
    queueOf();
    await service.tick();
    expect(launched).toEqual([]);
    expect(inlined).toEqual([]);
  });

  it("stops claiming heavy at the runner cap; light keeps flowing", async () => {
    queueOf(heavy("h1"), heavy("h2"), heavy("h3"), light("l1"));
    service = makeService({ maxConcurrentRunners: 2 });
    await service.tick();
    // h3 was never claimed (stays pending for a later tick), not
    // claimed-and-orphaned — the claim stopped asking for `heavy`.
    expect(launched).toEqual(["h1", "h2"]);
    expect(inlined).toEqual(["l1"]);
  });

  it("stops claiming light at the inline cap; heavy keeps flowing", async () => {
    queueOf(light("l1"), light("l2"), light("l3"), heavy("h1"));
    service = makeService({ maxConcurrentInline: 2 });
    await service.tick();
    expect(inlined).toEqual(["l1", "l2"]);
    expect(launched).toEqual(["h1"]);
  });

  it("stops entirely when both lanes are at capacity", async () => {
    queueOf(light("l1"), heavy("h1"), light("l2"), heavy("h2"));
    service = makeService({ maxConcurrentRunners: 1, maxConcurrentInline: 1 });
    await service.tick();
    expect(inlined).toEqual(["l1"]);
    expect(launched).toEqual(["h1"]);
    // The last claim call still asked for something executable; once both
    // lanes filled, no further claim was attempted.
    const lastWeights = repo.claimNextPending.mock.calls.at(-1)?.[0];
    expect(lastWeights?.length).toBeGreaterThan(0);
  });

  it("is non-reentrant: a tick that starts while another is draining is a no-op", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const claims: ClaimedTask[] = [heavy("task-a"), heavy("task-b")];
    // First claim blocks until we release the gate, keeping tick #1 mid-drain.
    repo.claimNextPending.mockImplementation(async () => {
      await gate;
      return claims.shift() ?? null;
    });

    const first = service.tick(); // enters, blocks on the gate
    const second = service.tick(); // sees ticking=true, returns immediately
    await second;
    expect(launched).toEqual([]); // second tick did no work

    release();
    await first;
    expect(launched).toEqual(["task-a", "task-b"]); // first tick drained alone
  });

  it("survives a claim failure without throwing (retries next tick)", async () => {
    repo.claimNextPending.mockRejectedValueOnce(
      new Error("connection refused"),
    );
    await service.tick(); // must not reject
    expect(launched).toEqual([]);
    expect(inlined).toEqual([]);
  });
});
