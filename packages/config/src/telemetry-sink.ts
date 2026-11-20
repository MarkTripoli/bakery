import { z } from "zod";

/**
 * Where the server's telemetry goes (#23).
 *
 * Only the rotated structured log is configured here: a directory for it and its
 * bounds. Where measurements are sent (OpenTelemetry and, later, others) is set
 * in the app and stored encrypted; the old BAKERY_OTLP_ENDPOINT and
 * BAKERY_OTLP_HEADERS variables were removed and are refused at start-up rather
 * than ignored.
 *
 * With no variable set the config is `undefined` and the log is off.
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

export const TelemetrySinkConfigSchema = z.object({
  logDir: AbsolutePathSchema.optional().describe(
    "Directory receiving rotated structured telemetry logs; absent when log export is off.",
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
  "Telemetry written by the server itself: the rotated structured log directory and its bounds. Destinations that receive measurements are saved in the app, not here.",
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
  // Removed, not ignored: an operator who still sets these would otherwise see
  // telemetry silently stop. The destination is added in the app instead.
  if (
    env.BAKERY_OTLP_ENDPOINT !== undefined ||
    env.BAKERY_OTLP_HEADERS !== undefined
  ) {
    throw new Error("TELEMETRY_OTLP_ENV_REMOVED");
  }
  const logDir = env.BAKERY_TELEMETRY_LOG_DIR;
  const logMaxBytes = env.BAKERY_TELEMETRY_LOG_MAX_BYTES;
  const logMaxFiles = env.BAKERY_TELEMETRY_LOG_MAX_FILES;
  // Any telemetry variable at all means the operator intended to configure
  // telemetry, so the whole configuration is validated. Returning early on "no
  // destination" would silently ignore a malformed bound, and the operator would
  // find out by noticing the absence of data rather than at boot.
  if (
    logDir === undefined && logMaxBytes === undefined &&
    logMaxFiles === undefined
  ) return undefined;

  const parsed = TelemetrySinkConfigSchema.safeParse({
    logDir,
    logMaxBytes: readPositiveInt(logMaxBytes),
    logMaxFiles: readPositiveInt(logMaxFiles),
  });
  if (!parsed.success) throw new Error("TELEMETRY_SINK_CONFIG_INVALID");
  // A configuration with no log directory is refused rather than accepted: it
  // reads as "telemetry is configured" while nothing is written anywhere.
  if (parsed.data.logDir === undefined) {
    throw new Error("TELEMETRY_SINK_CONFIG_INVALID");
  }
  return parsed.data;
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  // Digits only: `Number("1e9")` and `Number(" 5 ")` both parse, and neither is
  // something an operator meant to write.
  if (!/^[0-9]{1,10}$/.test(value)) return Number.NaN;
  return Number(value);
}
