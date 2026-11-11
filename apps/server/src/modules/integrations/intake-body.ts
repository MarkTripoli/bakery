import { StandardError } from "@bakery/contracts/http";

/**
 * Largest webhook body the receiver reads: 256 KiB, the bound in
 * docs/technical-design/09-integrations.md section 4. GitHub caps its own
 * deliveries at 25 MiB; anything over this bound is refused, never truncated.
 */
export const INTAKE_MAX_BODY_BYTES = 262_144;

const CONTENT_LENGTH_DIGITS = /^[0-9]+$/;

function bodyTooLarge(maxBytes: number): StandardError {
  return new StandardError({
    code: "BODY_TOO_LARGE",
    params: { limit: maxBytes },
  });
}

function bodyTimedOut(): StandardError {
  return new StandardError({ code: "DEPENDENCY_TIMEOUT" });
}

/** Resolves with the next chunk, or rejects with a timeout the moment `signal` aborts. */
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return await reader.read();
  if (signal.aborted) throw bodyTimedOut();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(bodyTimedOut());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** Releases a body nobody will read; a body that is locked or errored is already beyond use. */
function discard(body: ReadableStream<Uint8Array> | null): void {
  if (body === null) return;
  void body.cancel().catch(() => undefined);
}

/**
 * Reads the whole request body or fails, never returning a prefix. A missing
 * Content-Length is accepted. A Content-Length that is not plain digits, or
 * that exceeds `maxBytes`, fails before any byte is read. The bytes are then
 * counted chunk by chunk, so a body that lies about its length or has none
 * (chunked transfer) is cut off at the limit with the stream cancelled. No
 * JSON parsing happens here: the caller needs the exact bytes for the HMAC.
 *
 * `signal` bounds the read in time. The read happens before the signature is
 * checked, so a caller that trickles bytes would otherwise hold the request
 * open unauthenticated: when the signal aborts, the stream is cancelled and
 * the read fails with DEPENDENCY_TIMEOUT (504), as the shared JSON router does
 * (packages/contracts/src/http.ts readBody).
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    // A NaN or negative limit would turn the count below into an unbounded read.
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!CONTENT_LENGTH_DIGITS.test(declared) || Number(declared) > maxBytes)
  ) {
    discard(request.body);
    throw bodyTooLarge(maxBytes);
  }
  const body = request.body;
  if (body === null) return new Uint8Array(0);
  if (signal?.aborted) {
    discard(body);
    throw bodyTimedOut();
  }
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await readChunk(reader, signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw bodyTooLarge(maxBytes);
      }
      chunks.push(next.value);
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  // An abort that cancelled the stream ends the loop as a clean end of body.
  if (signal?.aborted) throw bodyTimedOut();
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
