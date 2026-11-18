import { z } from "zod";

/**
 * Where the server's telemetry goes (#23).
 *
 * Two destinations, both optional, and the shape is deliberately boring: a
 * directory for rotated structured logs, and at most one OTLP endpoint. The
 * design doc asks for exactly that - "start with structured rotated logs,
 * existing ledger-derived metrics and a single optional OTLP destination" - and
 * a second OTLP destination would be a fan-out the operator did not ask for.
 *
 * With neither variable set the config is `undefined` and export stays disabled,
 * which is the behaviour the server had before this slice: an event costs a
 * counter and nothing is queued.
 */

/** A path the server owns, absolute, with no control characters. */
const AbsolutePathSchema = z.string().min(1).max(4096).regex(/^\//).refine(
  (value) =>
    Array.from(value).every((character) =>
      character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    ),
  "Invalid telemetry log directory.",
).describe(
  "Absolute path to the server-owned directory that receives rotated structured telemetry logs.",
);

/**
 * An OTLP/HTTP endpoint.
 *
 * `https` only, and no credentials in the URL: a telemetry destination that
 * carries a password in its path ends up in the very logs it is exporting to.
 * Authentication belongs in the header map, which is not logged.
 */
const OtlpEndpointSchema = z.string().min(1).max(2048).refine(
  (value) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return false;
      if (url.username !== "" || url.password !== "") return false;
      // A collector base, not a signal URL: one URL cannot serve both traces and
      // metrics, so an endpoint that names a signal is refused instead of
      // silently dropping the other half of the telemetry.
      return !/\/v1\/(?:traces|metrics)$/.test(value.replace(/\/+$/, ""));
    } catch {
      return false;
    }
  },
  "Invalid OTLP endpoint.",
).describe(
  "HTTPS OTLP/HTTP collector base URL, without a signal path; the server appends /v1/traces and /v1/metrics, and credentials belong in headers.",
);

/**
 * Header name to header value, as an operator writes it.
 *
 * Kept as a closed shape because telemetry headers usually carry a collector
 * token: the values are secrets, so they are never included in an error, never
 * logged, and never part of a metric label.
 */
const HeaderNameSchema = z.string().min(1).max(64).regex(
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/,
).describe("HTTP header name of an OTLP request header.");

const HeaderValueSchema = z.string().min(1).max(2048).refine(
  (value) =>
    Array.from(value).every((character) => {
      const code = character.charCodeAt(0);
      // No CR/LF or other control characters: a header value that can break a
      // line is a request-splitting primitive, not a configuration mistake.
      return code >= 32 && code !== 127;
    }),
  "Invalid header value.",
).describe(
  "OTLP request header value, commonly a collector token; treated as secret and never logged.",
);

const OtlpHeadersSchema = z.record(HeaderNameSchema, HeaderValueSchema)
  .describe(
    "OTLP request headers, commonly a collector token; treated as secret and never logged.",
  );

export const TelemetrySinkConfigSchema = z.object({
  logDir: AbsolutePathSchema.optional().describe(
    "Directory receiving rotated structured telemetry logs; absent when log export is off.",
  ),
  otlpEndpoint: OtlpEndpointSchema.optional().describe(
    "Optional single OTLP/HTTP destination; absent when OTLP export is off.",
  ),
  /**
   * Bytes per log file before it rotates. Bounded on both ends: a tiny cap
   * rotates on every batch and a huge one defeats the point of rotating.
   */
  logMaxBytes: z.number().int().min(4096).max(1_073_741_824).optional()
    .describe(
      "Bytes per log file before it rotates; defaults to eight megabytes.",
    ),
  /** How many rotated files to keep, including the current one. */
  logMaxFiles: z.number().int().min(1).max(64).optional().describe(
    "Rotated log files kept on disk, including the current one; defaults to five.",
  ),
  otlpHeaders: OtlpHeadersSchema.optional().describe(
    "Headers sent with every OTLP request, such as an authorization token.",
  ),
}).strict().describe(
  "Telemetry destinations: rotated structured logs and at most one optional OTLP endpoint.",
);

export type TelemetrySinkConfig = z.infer<typeof TelemetrySinkConfigSchema>;

/** Defaults chosen so a local run rotates daily-ish rather than per batch. */
export const TELEMETRY_LOG_MAX_BYTES = 8 * 1024 * 1024;
export const TELEMETRY_LOG_MAX_FILES = 5;

/**
 * Reads the sink configuration.
 *
 * Undefined when nothing is configured, so a server with no telemetry
 * destination behaves exactly as it did before. A partial or malformed
 * configuration throws a content-free error rather than silently disabling
 * export: an operator who set a variable and got no telemetry should find out at
 * boot, not by noticing the absence of data weeks later.
 */
export function readTelemetrySinkConfig(
  env: Record<string, string | undefined>,
): TelemetrySinkConfig | undefined {
  const logDir = env.BAKERY_TELEMETRY_LOG_DIR;
  const otlpEndpoint = env.BAKERY_OTLP_ENDPOINT;
  const logMaxBytes = env.BAKERY_TELEMETRY_LOG_MAX_BYTES;
  const logMaxFiles = env.BAKERY_TELEMETRY_LOG_MAX_FILES;
  const otlpHeaders = env.BAKERY_OTLP_HEADERS;
  // Any telemetry variable at all means the operator intended to configure
  // telemetry, so the whole configuration is validated. Returning early on "no
  // destination" would silently ignore a malformed bound, and the operator would
  // find out by noticing the absence of data rather than at boot.
  if (
    logDir === undefined && otlpEndpoint === undefined &&
    logMaxBytes === undefined && logMaxFiles === undefined &&
    otlpHeaders === undefined
  ) return undefined;

  const parsed = TelemetrySinkConfigSchema.safeParse({
    logDir,
    otlpEndpoint,
    logMaxBytes: readPositiveInt(logMaxBytes),
    logMaxFiles: readPositiveInt(logMaxFiles),
    otlpHeaders: parseHeaders(otlpHeaders),
  });
  if (!parsed.success) throw new Error("TELEMETRY_SINK_CONFIG_INVALID");
  return parsed.data;
}

/**
 * Parses `name=value` pairs separated by commas or semicolons.
 *
 * An entry with no `=` is refused rather than skipped: a header the operator
 * wrote and the server silently dropped is an authentication failure they would
 * debug as a token problem. The error names no value.
 */
export function parseHeaders(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const headers: Record<string, string> = {};
  for (const entry of raw.split(/[,;]/)) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const separator = trimmed.indexOf("=");
    // Thrown rather than skipped, and never naming the value: a dropped header
    // is an authentication failure an operator would debug as a token problem.
    if (separator <= 0) throw new Error("TELEMETRY_SINK_CONFIG_INVALID");
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (name === "" || value === "") {
      throw new Error("TELEMETRY_SINK_CONFIG_INVALID");
    }
    headers[name] = value;
  }
  return Object.keys(headers).length === 0 ? undefined : headers;
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // Digits only: `Number("1e9")` and `Number(" 5 ")` both parse, and neither is
  // something an operator meant to write.
  if (!/^[0-9]{1,10}$/.test(value)) return Number.NaN;
  return Number(value);
}
