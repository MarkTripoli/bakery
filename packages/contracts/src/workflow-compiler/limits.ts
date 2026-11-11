/**
 * Hard ceilings for the pure workflow compiler. Every pass reads these
 * constants; none is configurable per call, so a hostile definition cannot
 * raise its own bounds.
 */
export const WORKFLOW_COMPILER_LIMITS = Object.freeze({
  /** Maximum canonical definition size in UTF-8 bytes (doc 06 YAML/JSON rules). */
  bytes: 100_000,
  /** Maximum JSON nesting depth accepted by the decoder and snapshot. */
  jsonDepth: 64,
  /** Maximum number of JSON values (containers and scalars) in one definition. */
  jsonValues: 20_000,
  /** Maximum characters in one JSON number token. */
  numberTokenChars: 64,
  /** Maximum node nesting depth (sequence, branch arm, repeat body, lane). */
  nodeDepth: 8,
  /** Maximum number of authored nodes. */
  authoredNodes: 200,
  /** Maximum items in a value list that holds a reference. */
  valueListItems: 1_000,
  /** Maximum expanded step count after repeat and parallel expansion. */
  expandedSteps: 1000,
  /** Compiler ceiling for the worst-case attempt count. */
  worstCaseAttempts: 1000,
  /** Maximum `repeat.max`. */
  repeatMax: 8,
  /** Maximum lanes in one parallel group. */
  lanes: 8,
  /** Smallest accepted action timeout, wait and wall-clock duration. */
  durationMinMs: 1_000,
  /** Timeout applied when an action declares none. */
  defaultActionTimeoutMs: 30 * 60 * 1_000,
  /** Largest accepted action timeout, maxDuration, wait and wall-clock duration. */
  durationMaxMs: 24 * 60 * 60 * 1_000,
  /** Largest accepted retry backoff. */
  backoffMaxMs: 60 * 60 * 1_000,
  /** Largest accepted `maxFindings` limit. */
  maxFindings: 1_000,
  /** Bounds applied to one expression string before and during parsing. */
  expression: Object.freeze({
    length: 1_024,
    depth: 32,
    nodes: 128,
    listItems: 32,
  }),
  /** Maximum expanded node count of one author-built value type. */
  valueTypeNodes: 4_096,
  /** Maximum diagnostics returned before `diagnostics_truncated`. */
  diagnostics: 100,
});

const DURATION_PATTERN = /^(0|[1-9][0-9]{0,5})(ms|s|m|h|d)$/;

const DURATION_UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
});

/**
 * Parses a duration literal such as `30m` or `1800s` to integer milliseconds.
 * Returns `null` for anything that is not a bounded `<digits><unit>` literal.
 * The per-field minimum and maximum are applied by the caller.
 */
export function parseDuration(text: unknown): number | null {
  if (typeof text !== "string" || text.length > 8) return null;
  const match = DURATION_PATTERN.exec(text);
  if (!match) return null;
  return Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
}
