import type { ErrorEvent, StackFrame, StreamedSpanJSON } from "@sentry/core";
import type { SentryConfig, SentryService } from "./sentry.ts";

type SpanAttribution = {
  readonly environment: string;
  readonly release: string;
  readonly service: SentryService;
};

const spanNames: Readonly<Record<string, string>> = {
  "http.server": "HTTP server request",
  "http.client": "HTTP client request",
  pageload: "Page load",
  navigation: "Page navigation",
  "queue.process": "Execute worker assignment",
  "resource.script": "Load script",
  "resource.css": "Load stylesheet",
};

function safeCodePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) {
    return value.split(/[?#]/, 1)[0];
  }
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}

function safeFrame(frame: StackFrame): StackFrame {
  return {
    filename: safeCodePath(frame.filename),
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
    debug_id: frame.debug_id,
  };
}

/**
 * Operation names a client may attach to a reported handled failure. Hyphenated
 * resource names are valid; anything outside this shape is dropped entirely.
 */
export const sentryOperationName = /^[a-z][A-Za-z0-9.-]*$/;

/**
 * Attribution tags the browser adds for handled data-layer failures. Their
 * values stay inside a strict shape, so a tag can never carry request content.
 */
const attributionTags: Record<string, RegExp> = {
  "bakery.source": /^(?:query|mutation)$/,
  "bakery.operation": sentryOperationName,
};

function safeAttributionTags(tags: ErrorEvent["tags"]) {
  const kept: Record<string, string> = {};
  for (const [name, pattern] of Object.entries(attributionTags)) {
    const value = tags?.[name];
    if (typeof value === "string" && pattern.test(value)) kept[name] = value;
  }
  return kept;
}

/**
 * Grouping identity for a reported handled failure, which has to survive this
 * filter to have any effect: a returned event replaces the original outright,
 * so a fingerprint dropped here leaves Sentry grouping on the stack trace, and
 * every handled failure shares one call site and one redacted message. That
 * collapses every operation in the application into a single issue.
 *
 * Only the shape the client is allowed to send survives, carrying the same
 * values already admitted as attribution tags, so a fingerprint can no more
 * carry request content than a tag can.
 */
function safeFingerprint(
  fingerprint: ErrorEvent["fingerprint"],
): string[] | undefined {
  if (fingerprint?.length !== 3) return undefined;
  const [owner, source, operation] = fingerprint;
  if (owner !== "bakery") return undefined;
  if (!attributionTags["bakery.source"].test(source)) return undefined;
  if (!sentryOperationName.test(operation)) return undefined;
  return [owner, source, operation];
}

export function sanitizeSentryError(
  event: ErrorEvent,
  service: SentryService,
): ErrorEvent {
  const trace = event.contexts?.trace;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    release: event.release,
    environment: event.environment,
    sdk: event.sdk,
    debug_meta: event.debug_meta
      ? {
        images: event.debug_meta.images?.flatMap((image) => {
          if (image.type !== "sourcemap") return [];
          const codeFile = safeCodePath(image.code_file);
          return codeFile
            ? [{
              type: "sourcemap" as const,
              debug_id: image.debug_id,
              code_file: codeFile,
            }]
            : [];
        }),
      }
      : undefined,
    tags: { service, ...safeAttributionTags(event.tags) },
    fingerprint: safeFingerprint(event.fingerprint),
    contexts: trace
      ? {
        trace: {
          trace_id: trace.trace_id,
          span_id: trace.span_id,
          parent_span_id: trace.parent_span_id,
        },
      }
      : undefined,
    exception: {
      values: event.exception?.values?.map((exception) => ({
        type: exception.type,
        value: "Unexpected application error",
        mechanism: exception.mechanism
          ? {
            type: exception.mechanism.type,
            handled: exception.mechanism.handled,
          }
          : undefined,
        stacktrace: exception.stacktrace
          ? { frames: exception.stacktrace.frames?.map(safeFrame) }
          : undefined,
      })),
    },
  };
}

export function sanitizeSentrySpan(
  span: StreamedSpanJSON,
  safeNames?: ReadonlySet<string>,
  attribution?: SpanAttribution,
): StreamedSpanJSON {
  const op = span.attributes["sentry.op"];
  const operation = typeof op === "string" && Object.hasOwn(spanNames, op)
    ? op
    : "function";
  const sampleRate = span.attributes["sentry.sample_rate"];
  const kind = span.attributes["sentry.kind"];
  const segmentId = span.is_segment
    ? span.span_id
    : span.attributes["sentry.segment.id"];
  const segmentName = span.attributes["sentry.segment.name"];
  return {
    trace_id: span.trace_id,
    parent_span_id: span.parent_span_id,
    span_id: span.span_id,
    name: safeNames?.has(span.name)
      ? span.name
      : spanNames[operation] ?? "Application operation",
    start_timestamp: span.start_timestamp,
    end_timestamp: span.end_timestamp,
    status: span.status,
    is_segment: span.is_segment,
    attributes: {
      "sentry.op": operation,
      "sentry.origin": "manual",
      "sentry.trace.lifecycle": "stream",
      ...(attribution
        ? {
          "sentry.environment": attribution.environment,
          "sentry.release": attribution.release,
          "service.name": attribution.service,
        }
        : {}),
      ...(typeof segmentId === "string" && /^[a-f0-9]{16}$/.test(segmentId)
        ? { "sentry.segment.id": segmentId }
        : {}),
      "sentry.segment.name":
        typeof segmentName === "string" && safeNames?.has(segmentName)
          ? segmentName
          : "Application operation",
      ...(typeof sampleRate === "number" && Number.isFinite(sampleRate) &&
          sampleRate >= 0 && sampleRate <= 1
        ? { "sentry.sample_rate": sampleRate }
        : {}),
      ...(kind === "client" || kind === "server" || kind === "internal" ||
          kind === "consumer" || kind === "producer"
        ? { "sentry.kind": kind }
        : {}),
    },
  };
}

export function sentryPrivacyOptions(
  service: SentryService,
  config: Extract<SentryConfig, { enabled: true }>,
  safeNames?: ReadonlySet<string>,
) {
  return {
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    beforeSend: (event: ErrorEvent) => sanitizeSentryError(event, service),
    beforeSendSpan: (span: StreamedSpanJSON) =>
      sanitizeSentrySpan(span, safeNames, {
        environment: config.environment,
        release: config.release,
        service,
      }),
    beforeBreadcrumb: () => null,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
  };
}
