/**
 * The only way a value reaches a telemetry sink. Content filtering happens
 * here, before any exporter, log file or collector sees a field, so nothing
 * downstream has to be trusted to scrub.
 *
 * The filter is an allowlist on both axes. A field must be one of a closed set
 * of registered names, and its value must have the exact scalar shape that name
 * allows: a UUID, a short identifier, a code, a bounded number. Free text
 * cannot pass, so a prompt, a diff, source code, tool arguments, output text,
 * an error message or a header has no field to ride in whatever a call site
 * passes. Call sites hand over structured facts, never content.
 *
 * What the shape rules do not do: they cannot tell a short identifier from a
 * short fragment of a secret that a call site wrongly placed in an identifier
 * field. They make that unlikely (a random token has too many capitals and
 * digits to look like a name, and known credential prefixes are refused), and
 * a field longer than a plausible identifier never passes.
 */

/** Longest string any field accepts; ids and digests are shorter by shape. */
export const MAX_TELEMETRY_STRING_LENGTH = 96;

/** Longest accepted duration: a year plus a day, in milliseconds. */
const MAX_DURATION_MS = 366 * 86_400_000;

/** Largest accepted counter. Counts here are retries and attempts. */
const MAX_COUNT = 1_000_000;

/** Fields examined per record; a hostile object cannot make the filter scan more. */
const MAX_EXAMINED_KEYS = 256;

const NAME_MAX_SEGMENTS = 8;
const NAME_SEGMENT = /^[a-z][A-Za-z0-9]{0,39}$/;
const CODE_MAX_SEGMENTS = 8;
const CODE_SEGMENT = /^[A-Z][A-Z0-9]{0,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Prefixes of credential formats that must never be taken for a name. */
const CREDENTIAL_PREFIX =
  /^(?:gh[pousr]_|github_pat_|glpat-|xox[a-z]-|sk[-_]|pk[-_]|rk[-_]|bearer)/i;

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

/**
 * A segment a person chose, like `integrationAppRegistrations`: a few humps and
 * almost no digits. Random credential material has many of both.
 */
function looksChosen(segment: string): boolean {
  return countMatches(segment, /[A-Z]/g) <= 4 &&
    countMatches(segment, /[0-9]/g) <= 3;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 &&
    SHA256_HEX.test(value);
}

/** Dotted, dashed or underscored identifier such as `agents.activateVersion`. */
function isName(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_TELEMETRY_STRING_LENGTH) {
    return false;
  }
  if (CREDENTIAL_PREFIX.test(value)) return false;
  const segments = value.split(/[._-]/);
  return segments.length <= NAME_MAX_SEGMENTS &&
    segments.every((segment) =>
      NAME_SEGMENT.test(segment) && looksChosen(segment)
    );
}

/** Upper snake code such as `AUTH_FORBIDDEN`. */
function isCode(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_TELEMETRY_STRING_LENGTH) {
    return false;
  }
  const segments = value.split("_");
  return segments.length <= CODE_MAX_SEGMENTS &&
    segments.every((segment) =>
      CODE_SEGMENT.test(segment) && countMatches(segment, /[0-9]/g) <= 3
    );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= MAX_COUNT;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    value <= MAX_DURATION_MS;
}

function isFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

type Validator = (value: unknown) => boolean;

/**
 * Registered fields and the one shape each accepts. Durable ids correlate work
 * (a trace carries them, a metric label never does); nothing here is content.
 */
const registry: ReadonlyMap<string, Validator> = new Map<string, Validator>([
  ["bakery.run.id", isUuid],
  ["bakery.attempt.id", isUuid],
  ["bakery.job.id", isUuid],
  ["bakery.task.id", isUuid],
  ["bakery.repository.id", isUuid],
  ["bakery.step.key", isName],
  ["bakery.action", isName],
  ["bakery.provider.category", isName],
  ["bakery.outcome", isCode],
  ["bakery.actor.hash", isDigest],
  ["bakery.duration_ms", isDuration],
  ["bakery.retry.count", isCount],
  ["bakery.logical_attempt", isCount],
  ["bakery.lease.lost", isFlag],
]);

/** Every field name a record may carry. */
export const TELEMETRY_ATTRIBUTE_NAMES: readonly string[] = Object.freeze([
  ...registry.keys(),
]);

/** What survived the filter, and how much did not, without echoing any of it. */
export type RedactedTelemetryAttributes = {
  /** Registered fields whose values had the right shape. No prototype. */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  /**
   * Fields dropped because their name is not registered, or because the record
   * held more than the examined limit. Names are not kept.
   */
  readonly unregisteredCount: number;
  /** Registered names whose value was refused. The value is never reported. */
  readonly invalid: readonly string[];
};

function nothing(unregisteredCount = 0): RedactedTelemetryAttributes {
  return {
    attributes: Object.create(null),
    unregisteredCount,
    invalid: [],
  };
}

/**
 * Reduces any object to the registered, correctly shaped fields it holds. It
 * never throws and never reads beyond the object's own enumerable string keys,
 * so a hostile or broken input costs the caller nothing but a missing field.
 */
export function redactTelemetryAttributes(
  input: unknown,
): RedactedTelemetryAttributes {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return nothing();
  }
  let keys: string[];
  try {
    keys = Object.keys(input);
  } catch {
    return nothing();
  }
  const attributes: Record<string, string | number | boolean> = Object.create(
    null,
  );
  const invalid: string[] = [];
  let unregisteredCount = Math.max(0, keys.length - MAX_EXAMINED_KEYS);
  for (const key of keys.slice(0, MAX_EXAMINED_KEYS)) {
    const accepts = registry.get(key);
    if (!accepts) {
      unregisteredCount += 1;
      continue;
    }
    let value: unknown;
    try {
      value = (input as Record<string, unknown>)[key];
    } catch {
      invalid.push(key);
      continue;
    }
    if (accepts(value)) {
      attributes[key] = value as string | number | boolean;
    } else {
      invalid.push(key);
    }
  }
  return { attributes, unregisteredCount, invalid };
}
