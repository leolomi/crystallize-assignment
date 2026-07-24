/**
 * Run `fn` over `items` with at most `concurrency` in flight at once — the
 * runner's bounded-concurrency primitive.
 *
 * `shouldStop` is polled before each item is *started* (never mid-flight): once
 * it returns true, no new work begins but everything already in flight is
 * awaited to completion. That is exactly the graceful-shutdown contract —
 * finish in-flight rows, start no new ones.
 */
export async function mapPool<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      if (shouldStop()) return;
      const item = items[cursor++];
      await fn(item);
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    worker,
  );
  await Promise.all(workers);
}
