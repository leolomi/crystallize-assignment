import { describe, expect, it } from "bun:test";
import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

import { ndjsonStream } from "./ndjson-stream";

const rowSchema = z.object({ id: z.string(), price: z.number() });

const streamOf = (...lines: string[]) => [lines.join("\n")];

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of gen) out.push(item);
  return out;
}

describe("ndjsonStream", () => {
  it("yields parsed, schema-validated objects line by line", async () => {
    const rows = await collect(
      ndjsonStream(
        streamOf('{"id":"p1","price":1.5}', '{"id":"p2","price":2.5}'),
        rowSchema,
      ),
    );
    expect(rows).toEqual([
      { id: "p1", price: 1.5 },
      { id: "p2", price: 2.5 },
    ]);
  });

  it("reassembles a line split across chunks", async () => {
    const rows = await collect(
      ndjsonStream(
        ['{"id":"p1","pri', 'ce":1}\n{"id":', '"p2","price":2}'],
        rowSchema,
      ),
    );
    expect(rows).toEqual([
      { id: "p1", price: 1 },
      { id: "p2", price: 2 },
    ]);
  });

  it("decodes binary chunks, keeping multi-byte UTF-8 intact across boundaries", async () => {
    const bytes = new TextEncoder().encode('{"id":"héllo","price":1}\n');
    // Split in the middle of the 2-byte "é" sequence.
    const cut = 10;
    const rows = await collect(
      ndjsonStream([bytes.slice(0, cut), bytes.slice(cut)], rowSchema),
    );
    expect(rows).toEqual([{ id: "héllo", price: 1 }]);
  });

  it("skips blank lines and handles CRLF endings", async () => {
    const rows = await collect(
      ndjsonStream(['\r\n{"id":"p1","price":1}\r\n   \r\n'], rowSchema),
    );
    expect(rows).toEqual([{ id: "p1", price: 1 }]);
  });

  it("throws a 400 naming the line on invalid JSON", async () => {
    await expect(
      collect(
        ndjsonStream(streamOf('{"id":"p1","price":1}', "{oops"), rowSchema),
      ),
    ).rejects.toThrow("invalid JSON on line 2");
  });

  it("throws a 400 naming the line and field on a schema violation", async () => {
    const promise = collect(ndjsonStream(streamOf('{"id":"p1"}'), rowSchema));
    await expect(promise).rejects.toThrow(BadRequestException);
    await expect(promise).rejects.toThrow(/line 1:.*price/s);
  });

  it("yields nothing for an empty body", async () => {
    expect(await collect(ndjsonStream([""], rowSchema))).toEqual([]);
  });
});
