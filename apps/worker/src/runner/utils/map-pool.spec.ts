import { describe, expect, it } from "bun:test";
import { mapPool } from "./map-pool";

/**
 * Unit tests for the runner's bounded-concurrency primitive — the whole
 * graceful-shutdown story rests on its contract: never more than `concurrency`
 * in flight, and `shouldStop` prevents new starts while in-flight work is
 * always drained to completion.
 */
describe("mapPool", () => {
  it("processes every item with at most `concurrency` in flight", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    const seen: number[] = [];
    let inFlight = 0;
    let peak = 0;

    await mapPool(items, 3, async (i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1);
      seen.push(i);
      inFlight--;
    });

    expect(seen.toSorted((a, b) => a - b)).toEqual(items);
    expect(peak).toBe(3);
  });

  it("never spawns more workers than there are items", async () => {
    let inFlight = 0;
    let peak = 0;

    await mapPool([1, 2], 10, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(1);
      inFlight--;
    });

    expect(peak).toBe(2);
  });

  it("shouldStop halts new starts but drains in-flight items to completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started: number[] = [];
    const finished: number[] = [];
    let stop = false;

    const run = mapPool(
      [0, 1, 2, 3, 4],
      2,
      async (i) => {
        started.push(i);
        await gate;
        finished.push(i);
      },
      () => stop,
    );

    // Both workers are mid-flight on the gate; stop, then release.
    while (started.length < 2) {
      await Bun.sleep(1);
    }
    stop = true;
    release();
    await run;

    expect(started).toEqual([0, 1]); // items 2-4 never began
    expect(finished).toEqual([0, 1]); // in-flight work completed, not abandoned
  });

  it("is a no-op on an empty item list", async () => {
    let calls = 0;
    await mapPool([], 4, async () => {
      calls++;
    });
    expect(calls).toBe(0);
  });
});
