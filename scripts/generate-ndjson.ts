/**
 * Generate an NDJSON bulk job for testing. Lines are bare payloads for
 * POST /tasks/product-price-updates:
 *   {"id":"prod-0","price":42.5}
 *
 * Usage: bun run seed [rowCount] [outFile]
 *   bun run seed 50000 job.ndjson
 *
 * (A catalogue_reindex job is a plain JSON POST — no generator needed:
 *   curl -XPOST .../tasks/catalogue-reindex -H 'Content-Type: application/json' \
 *     -d '{"catalogue":"products"}')
 */
// No imports here, so tsc needs this to treat the file as a module (top-level
// await is only legal in modules).
export {};

const count = Number(process.argv[2] ?? 50000);
const out = process.argv[3] ?? "job.ndjson";

// Build in memory and write once: Bun.write truncates the destination, whereas
// an incremental FileSink can leave stale bytes when overwriting a longer file.
const lines: string[] = [];
for (let i = 0; i < count; i++) {
  const price = Math.round((1 + Math.random() * 999) * 100) / 100;
  lines.push(JSON.stringify({ id: `prod-${i}`, price }));
}
await Bun.write(out, `${lines.join("\n")}\n`);

console.log(`✓ wrote ${count} product price update rows to ${out}`);
