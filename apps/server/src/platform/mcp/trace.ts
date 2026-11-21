import { parseTraceparent } from "@bakery/config/telemetry-trace";

/**
 * The trace an MCP call arrives in: the `traceparent` header of the request
 * that carried it, when there is one.
 *
 * A tool call is one leg of whatever run its caller is part of, so the call
 * continues the caller's trace instead of starting an unrelated one. A header
 * that is not a well-formed version-00 traceparent is ignored, because a
 * malformed one must never refuse a call or be written into a row.
 */
export type McpCallTrace = Readonly<{ traceparent?: string }>;

/** The caller's traceparent when it is well formed, else undefined. */
export function callerTraceparent(
  trace: McpCallTrace | undefined,
): string | undefined {
  const value = trace?.traceparent;
  return parseTraceparent(value) === undefined ? undefined : value;
}
