import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import { z } from "zod";

type ByteChunk = Uint8Array | string;
type ByteInput = Iterable<ByteChunk> | AsyncIterable<ByteChunk>;
type ByteIterator = AsyncIterator<ByteChunk> | Iterator<ByteChunk>;

const byteSize = (chunk: ByteChunk): number =>
  typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;

const iteratorOf = (input: ByteInput): ByteIterator =>
  Symbol.asyncIterator in input
    ? input[Symbol.asyncIterator]()
    : input[Symbol.iterator]();

/**
 * Split a byte/text stream into lines, enforcing `maxBytes` (413) on the wire
 * bytes as they arrive — never against a declared Content-Length, which
 * chunked encoding may omit or understate. TextDecoder in streaming mode keeps
 * multi-byte UTF-8 sequences intact across chunk boundaries; the tail buffer
 * carries a line split across chunks until its newline arrives.
 *
 * Iterates the source manually rather than with `for await`: an error's abrupt
 * exit from `for await` returns — and on bun thereby destroys — the underlying
 * request stream while bytes are still unread, and bun's node:http then emits
 * a bare `200 OK`/`Connection: close` instead of the real error status. Manual
 * iteration leaves the stream alive for ndjsonStream's bounded error drain.
 */
async function* splitLines(
  bytes: ByteIterator,
  maxBytes?: number,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffered = "";
  let total = 0;
  for (;;) {
    const next = await bytes.next();
    if (next.done) break;
    const chunk = next.value;
    if (maxBytes !== undefined) {
      total += byteSize(chunk);
      if (total > maxBytes) {
        throw new PayloadTooLargeException(
          `body exceeds the ${maxBytes}-byte limit`,
        );
      }
    }
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
 * Read and discard what remains of the stream so an error response can be
 * delivered: bun's node:http cannot flush a status over a request that still
 * has unread bytes (see splitLines). Bounded — a client that keeps streaming
 * a full extra budget past the error is not acting in good faith and gets its
 * connection closed instead of a status.
 */
async function discardRemainder(
  bytes: ByteIterator,
  budget: number,
): Promise<void> {
  let drained = 0;
  while (drained <= budget) {
    const next = await bytes.next();
    if (next.done) return;
    drained += byteSize(next.value);
  }
  await bytes.return?.();
}

/**
 * Turn an NDJSON request body into a typed AsyncGenerator (inspired by
 * nest-ndjson-req-stream): each non-blank line is parsed and validated against
 * `schema` as it arrives, so consumers iterate domain objects — never raw
 * lines — and a 50k-line body is never buffered whole in memory.
 *
 * A malformed or invalid line throws a 400 naming the offending line, and a
 * body larger than `maxBytes` a 413; the error surfaces at the consumer's
 * `for await`, which lets it clean up whatever it already persisted.
 */
export async function* ndjsonStream<T>(
  input: ByteInput,
  schema: z.ZodType<T>,
  options: { maxBytes?: number } = {},
): AsyncGenerator<T> {
  const bytes = iteratorOf(input);
  let line = 0;
  try {
    for await (const raw of splitLines(bytes, options.maxBytes)) {
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
  } catch (err) {
    // Deliverability, not correctness: `maxBytes` doubles as the drain budget,
    // so without it behavior stays as before.
    if (options.maxBytes !== undefined) {
      try {
        await discardRemainder(bytes, options.maxBytes);
      } catch {
        // the response outcome is already decided by `err`
      }
    }
    throw err;
  }
}
