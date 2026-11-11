/**
 * W3C Trace Context for the operation, outbox, engine, worker and effect
 * boundaries, as plain data. Nothing here starts a span, holds one open or
 * talks to a backend: a context is a pair of ids that can be written into a
 * durable row and read back after a restart.
 *
 * `tracestate` is deliberately not carried. It is vendor-owned free text, and
 * telemetry may only hold the identifier-shaped values this package allows.
 */

/** Identity of one span, and whether its trace is being recorded. */
export type TraceContext = {
  readonly traceId: string;
  readonly spanId: string;
  readonly sampled: boolean;
};

/** A reference to a span in another trace, for work that resumes after a gap. */
export type TraceLink = {
  readonly traceId: string;
  readonly spanId: string;
};

/** Source of random bytes; replaced in tests so ids are deterministic. */
export type RandomBytes = (length: number) => Uint8Array;

/** Links kept on one span, so a step retried for weeks cannot grow its record. */
export const MAX_TRACE_LINKS = 8;

/** Longest header read at all; a longer value is never a valid traceparent. */
const MAX_TRACEPARENT_LENGTH = 512;

const VERSION_00_LENGTH = 55;
const traceparentLayout =
  /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

const cryptoBytes: RandomBytes = (length) =>
  crypto.getRandomValues(new Uint8Array(length));

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Random lowercase hex of `byteLength` bytes that is never all zero, which the
 * specification reserves as invalid. A source that keeps returning zeros is
 * retried a few times and then forced non-zero rather than looping.
 */
function randomId(byteLength: number, random: RandomBytes): string {
  const zero = "0".repeat(byteLength * 2);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = hex(random(byteLength).slice(0, byteLength));
    if (candidate.length === byteLength * 2 && candidate !== zero) {
      return candidate;
    }
  }
  return `${"0".repeat(byteLength * 2 - 1)}1`;
}

/**
 * Reads a `traceparent` header. Anything that is not exactly the version-00
 * layout is refused, so the caller starts a new trace instead of continuing
 * one it cannot trust. A later version is read by the version-00 layout, which
 * the specification requires, and may only add fields after a dash.
 */
export function parseTraceparent(
  value: string | null | undefined,
): TraceContext | undefined {
  if (typeof value !== "string" || value.length > MAX_TRACEPARENT_LENGTH) {
    return undefined;
  }
  const match = traceparentLayout.exec(value);
  if (!match) return undefined;
  const [, version, traceId, spanId, flags] = match;
  if (version === "ff") return undefined;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  if (version === "00") {
    if (value.length !== VERSION_00_LENGTH) return undefined;
  } else if (
    value.length !== VERSION_00_LENGTH && value[VERSION_00_LENGTH] !== "-"
  ) return undefined;
  return {
    traceId,
    spanId,
    sampled: (Number.parseInt(flags, 16) & 1) === 1,
  };
}

/** Writes the header for a context; always version 00. */
export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${
    context.sampled ? "01" : "00"
  }`;
}

/** Starts a new trace, recorded by default. */
export function newTraceContext(
  random: RandomBytes = cryptoBytes,
): TraceContext {
  return {
    traceId: randomId(16, random),
    spanId: randomId(8, random),
    sampled: true,
  };
}

/** A new span in the parent's trace; the parent's sampling decision stands. */
export function childTraceContext(
  parent: TraceContext,
  random: RandomBytes = cryptoBytes,
): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: randomId(8, random),
    sampled: parent.sampled,
  };
}

/** The reference another trace stores to point back at this span. */
export function traceLinkOf(context: TraceContext | TraceLink): TraceLink {
  return { traceId: context.traceId, spanId: context.spanId };
}

/**
 * Work that resumes after a durable wait or a retry. The earlier span ended at
 * a real operation boundary; the wake begins a new trace and links back, so no
 * span stays open for days and the run, step and attempt ids (not the trace)
 * carry the correlation. `earlier` are links the resumed span already held,
 * oldest first; the link being resumed always survives, then the newest
 * history, up to {@link MAX_TRACE_LINKS}.
 */
export function linkedContinuation(
  resumed: TraceContext | TraceLink,
  earlier: readonly TraceLink[] = [],
  random: RandomBytes = cryptoBytes,
): { readonly context: TraceContext; readonly links: readonly TraceLink[] } {
  const keep = Math.max(0, MAX_TRACE_LINKS - 1);
  const history = keep === 0 ? [] : earlier.slice(-keep);
  const sampled = "sampled" in resumed ? resumed.sampled : true;
  return {
    context: { ...newTraceContext(random), sampled },
    links: [traceLinkOf(resumed), ...history.map(traceLinkOf)],
  };
}
