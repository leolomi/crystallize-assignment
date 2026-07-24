import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

/**
 * Split a byte/text stream into lines. TextDecoder in streaming mode keeps
 * multi-byte UTF-8 sequences intact across chunk boundaries; the tail buffer
 * carries a line split across chunks until its newline arrives.
 */
async function* splitLines(
  input: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of input) {
    buffered +=
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      yield buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  buffered += decoder.decode(); // flush a trailing partial UTF-8 sequence
  if (buffered.length > 0) yield buffered;
}

/**
 * Turn an NDJSON request body into a typed AsyncGenerator (inspired by
 * nest-ndjson-req-stream): each non-blank line is parsed and validated against
 * `schema` as it arrives, so consumers iterate domain objects — never raw
 * lines — and a 50k-line body is never buffered whole in memory.
 *
 * A malformed or invalid line throws a 400 naming the offending line; the
 * error surfaces at the consumer's `for await`, which lets it clean up
 * whatever it already persisted.
 */
export async function* ndjsonStream<T>(
  input: Iterable<Uint8Array | string> | AsyncIterable<Uint8Array | string>,
  schema: z.ZodType<T>,
): AsyncGenerator<T> {
  let line = 0;
  for await (const raw of splitLines(input)) {
    line++;
    const trimmed = raw.trim(); // also strips the \r of CRLF endings
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new BadRequestException(`invalid JSON on line ${line}`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new BadRequestException(
        `line ${line}: ${z.prettifyError(result.error)}`,
      );
    }
    yield result.data;
  }
}
