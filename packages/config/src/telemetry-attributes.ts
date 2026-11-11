/**
 * The only way a value reaches a telemetry sink. Content filtering happens
 * here, before any exporter, log file or collector sees a field, so nothing
 * downstream has to be trusted to scrub.
 *
 * The filter is an allowlist on both axes. A field must be one of a closed set
 * of registered names, and its value must be exactly what that name allows:
 *
 * - ids and digests: a UUID, a SHA-256 hex digest;
 * - numbers and flags: bounded counts and durations, a boolean;
 * - `bakery.action`, `bakery.provider.category`, `bakery.outcome`: a member of
 *   a closed vocabulary the consumer supplies, never a shape. The consumer is
 *   the code that owns the names (the action registry, the fault catalog), so
 *   this package neither guesses them nor depends on it;
 * - `bakery.step.key`: the runtime step-id grammar, the one open-ended field.
 *
 * Free text (prompts, diffs, source, output, headers, error messages) has no
 * field to ride in whatever a call site passes, and a value that merely looks
 * like a name cannot reach an action, provider or outcome field.
 *
 * What the step-key grammar does not do: tell a short fragment of a secret from
 * a short word. It is a lowercase identifier, so a fragment of a secret that is
 * also lowercase letters, digits and underscores can pass, most easily when the
 * secret's own alphabet is lowercase (hex, base32, base36), and so can a
 * snake_case sentence. The digit cap holds hex down at longer lengths. The
 * security test measures these rates with a seeded generator and fails if they
 * grow; the rates are stated in `tests/security`. A consumer that knows the
 * step ids of a run should check against them as well.
 */

/** Longest entry a vocabulary may hold, so a vocabulary stays names, not text. */
export const MAX_VOCABULARY_ENTRY_LENGTH = 96;

/** Most entries one vocabulary may hold; the implemented actions are far below. */
export const MAX_VOCABULARY_ENTRIES = 4096;

/**
 * The runtime step-id grammar. It is the same expression as `STEP_ID_PATTERN`
 * in `apps/server/src/modules/work/run-steps.ts` and
 * `apps/server/src/modules/workflows/validation.ts`; a unit test fails if
 * either of them drifts from this one.
 */
export const STEP_KEY_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Digits allowed in one step key. Real step ids carry none or one; the cap is
 * what keeps a hex fragment from passing the lowercase grammar about 37% of
 * the time whatever its length.
 */
export const STEP_KEY_MAX_DIGITS = 3;

/** Longest accepted duration: a year plus a day, in milliseconds. */
const MAX_DURATION_MS = 366 * 86_400_000;

/** Largest accepted counter. Counts here are retries and attempts. */
const MAX_COUNT = 1_000_000;

/** Fields examined per record; a hostile object cannot make the filter scan more. */
const MAX_EXAMINED_KEYS = 256;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && value.length === 36 && UUID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 &&
    SHA256_HEX.test(value);
}

function isStepKey(value: unknown): value is string {
  return typeof value === "string" && STEP_KEY_PATTERN.test(value) &&
    (value.match(/[0-9]/g)?.length ?? 0) <= STEP_KEY_MAX_DIGITS;
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
 * The names a consumer vouches for. Each set is copied when the redactor is
 * made, so changing the original afterwards cannot widen what is accepted. An
 * omitted set is empty: that field is refused until a vocabulary is supplied.
 */
export type TelemetryVocabulary = {
  /** Action ids, such as the implemented actions of `@bakery/contracts`. */
  readonly actions?: Iterable<string>;
  /** Provider categories the consumer emits; this package defines none. */
  readonly providerCategories?: Iterable<string>;
  /** Outcome codes, such as the keys of the fault catalog. */
  readonly outcomes?: Iterable<string>;
};

/** Copies a vocabulary entry list, refusing text that is not a short name. */
function closedSet(
  label: string,
  values: Iterable<string> | undefined,
): ReadonlySet<string> {
  const set = new Set<string>();
  for (const value of values ?? []) {
    if (
      typeof value !== "string" || value.length === 0 ||
      value.length > MAX_VOCABULARY_ENTRY_LENGTH
    ) {
      // The offending entry is deliberately not part of the message.
      throw new RangeError(
        `telemetry vocabulary ${label}: entries must be non-empty strings of at most ${MAX_VOCABULARY_ENTRY_LENGTH} characters`,
      );
    }
    set.add(value);
    if (set.size > MAX_VOCABULARY_ENTRIES) {
      throw new RangeError(
        `telemetry vocabulary ${label}: more than ${MAX_VOCABULARY_ENTRIES} entries`,
      );
    }
  }
  return set;
}

const member = (set: ReadonlySet<string>): Validator => (value) =>
  typeof value === "string" && set.has(value);

/**
 * Registered fields and the one shape each accepts. Durable ids correlate work
 * (a trace carries them, a metric label never does); nothing here is content.
 */
function registryFor(
  vocabulary: TelemetryVocabulary,
): ReadonlyMap<string, Validator> {
  const actions = closedSet("actions", vocabulary.actions);
  const providerCategories = closedSet(
    "providerCategories",
    vocabulary.providerCategories,
  );
  const outcomes = closedSet("outcomes", vocabulary.outcomes);
  return new Map<string, Validator>([
    ["bakery.run.id", isUuid],
    ["bakery.attempt.id", isUuid],
    ["bakery.job.id", isUuid],
    ["bakery.task.id", isUuid],
    ["bakery.repository.id", isUuid],
    ["bakery.step.key", isStepKey],
    ["bakery.action", member(actions)],
    ["bakery.provider.category", member(providerCategories)],
    ["bakery.outcome", member(outcomes)],
    ["bakery.actor.hash", isDigest],
    ["bakery.duration_ms", isDuration],
    ["bakery.retry.count", isCount],
    ["bakery.logical_attempt", isCount],
    ["bakery.lease.lost", isFlag],
  ]);
}

/** Every field name a record may carry. */
export const TELEMETRY_ATTRIBUTE_NAMES: readonly string[] = Object.freeze([
  ...registryFor({}).keys(),
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

function redact(
  registry: ReadonlyMap<string, Validator>,
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

/**
 * Builds the filter for one vocabulary. The returned function reduces any
 * object to the registered, correctly shaped fields it holds. It never throws
 * and never reads beyond the object's own enumerable string keys, so a hostile
 * or broken input costs the caller nothing but a missing field. Only the
 * vocabulary can throw, here, when it is built.
 */
export function createTelemetryRedactor(
  vocabulary: TelemetryVocabulary = {},
): (input: unknown) => RedactedTelemetryAttributes {
  const registry = registryFor(vocabulary);
  return (input) => redact(registry, input);
}

/**
 * The filter with no vocabulary: `bakery.action`, `bakery.provider.category`
 * and `bakery.outcome` are refused until a consumer builds its own with
 * {@link createTelemetryRedactor}.
 */
export const redactTelemetryAttributes: (
  input: unknown,
) => RedactedTelemetryAttributes = createTelemetryRedactor();
