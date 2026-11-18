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
      return url.protocol === "https:" && url.username === "" &&
        url.password === "";
    } catch {
      return false;
    }
  },
  "Invalid OTLP endpoint.",
).describe(
  "HTTPS OTLP/HTTP endpoint that receives exported telemetry batches; credentials belong in headers, never in the URL.",
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
  // Any telemetry variable at all means the operator intended to configure
  // telemetry, so the whole configuration is validated. Returning early on "no
  // destination" would silently ignore a malformed bound, and the operator would
  // find out by noticing the absence of data rather than at boot.
  if (
    logDir === undefined && otlpEndpoint === undefined &&
    logMaxBytes === undefined && logMaxFiles === undefined
  ) return undefined;

  const parsed = TelemetrySinkConfigSchema.safeParse({
    logDir,
    otlpEndpoint,
    logMaxBytes: readPositiveInt(logMaxBytes),
    logMaxFiles: readPositiveInt(logMaxFiles),
  });
  if (!parsed.success) throw new Error("TELEMETRY_SINK_CONFIG_INVALID");
  return parsed.data;
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // Digits only: `Number("1e9")` and `Number(" 5 ")` both parse, and neither is
  // something an operator meant to write.
  if (!/^[0-9]{1,10}$/.test(value)) return Number.NaN;
  return Number(value);
}
