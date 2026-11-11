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
 * - `bakery.action`, `bakery.provider.category`, `bakery.outcome` and
 *   `bakery.step.key`: a member of a closed vocabulary the consumer supplies,
 *   never a shape. The consumer is the code that owns the names (the action
 *   registry, the fault catalog, the compiled plan of a run), so this package
 *   neither guesses them nor depends on it.
 *
 * Free text (prompts, diffs, source, output, headers, error messages) has no
 * field to ride in whatever a call site passes, and a value that merely looks
 * like a name cannot reach any of the four vocabulary fields.
 *
 * Why a step key is a membership test and not a grammar. A lowercase
 * identifier grammar cannot tell a fragment of a lowercase token (hex, base32,
 * base36) or a snake_case sentence from a step name; measured, it let 45% of
 * 12-character base36 fragments through and, cutting a base32 secret in three,
 * all three pieces 30% of the time. Digit caps and entropy thresholds only move
 * that number, and word-like text defeats both. A run declares its steps, so
 * the key is accepted only when its id path is one of them: a piece of a secret
 * would have to equal a declared id. What remains free is the loop counter in
 * `id@n`, a number from 0 to 999.
 */

/** Longest entry a vocabulary may hold, so a vocabulary stays names, not text. */
export const MAX_VOCABULARY_ENTRY_LENGTH = 96;

/**
 * Most items one vocabulary may yield. Every item the iterable produces counts,
 * duplicates included, so an iterable that repeats one name for ever is stopped
 * after this many.
 */
export const MAX_VOCABULARY_ENTRIES = 4096;

/**
 * One segment of a qualified step id, the grammar the runtime enforces. It is
 * the same expression as `STEP_ID_PATTERN` in
 * `apps/server/src/modules/work/run-steps.ts` and
 * `apps/server/src/modules/workflows/validation.ts`; a unit test fails if
 * either of them drifts from this one.
 */
export const STEP_ID_SEGMENT = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * One segment of a concrete step key: an id segment and, inside a repeat, the
 * iteration it belongs to. It is the same expression as `SEGMENT` in
 * `packages/contracts/src/workflow-compiler/plan.ts`; a unit test fails if it
 * drifts.
 */
export const STEP_KEY_SEGMENT =
  /^([a-z][a-z0-9_]{1,63})(?:@(0|[1-9][0-9]{0,2}))?$/;

/** Deepest nesting a plan allows (8) plus the two levels its flattening adds. */
export const MAX_STEP_KEY_SEGMENTS = 10;

/** Longest step key: ten segments of 64 characters, each with `@999`, and dots. */
export const MAX_STEP_KEY_LENGTH = 1024;

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

/**
 * True for a dotted path of 1 to {@link MAX_STEP_KEY_SEGMENTS} id segments,
 * which is what a plan calls a qualified id.
 */
function isQualifiedStepId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_STEP_KEY_LENGTH) {
    return false;
  }
  const segments = value.split(".");
  return segments.length <= MAX_STEP_KEY_SEGMENTS &&
    segments.every((segment) => STEP_ID_SEGMENT.test(segment));
}

/**
 * Reads a concrete step key (`outer@2.inner@0.build`) down to its qualified id,
 * or returns nothing when any segment is not the compiler's grammar.
 */
function qualifiedIdOfStepKey(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_STEP_KEY_LENGTH) {
    return undefined;
  }
  const segments = value.split(".");
  const ids: string[] = [];
  for (const segment of segments) {
    const match = STEP_KEY_SEGMENT.exec(segment);
    if (!match) return undefined;
    ids.push(match[1]);
  }
  return ids.join(".");
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
  /**
   * Qualified step ids the run declares, such as the `qualifiedId` of every
   * step of its compiled plan. A key is accepted when its id path is one of
   * these; the `@n` loop markers need no entry.
   */
  readonly stepIds?: Iterable<string>;
};

type Sets = {
  readonly actions: ReadonlySet<string>;
  readonly providerCategories: ReadonlySet<string>;
  readonly outcomes: ReadonlySet<string>;
  readonly stepIds: ReadonlySet<string>;
};

/**
 * Copies a vocabulary into a set, refusing anything that is not a short name.
 * Every item the iterable yields counts toward {@link MAX_VOCABULARY_ENTRIES},
 * so no iterable can run for ever or make this hold more than that.
 */
function closedSet(
  label: string,
  values: Iterable<string> | undefined,
  accepts: (value: unknown) => value is string,
): ReadonlySet<string> {
  const set = new Set<string>();
  let yielded = 0;
  for (const value of values ?? []) {
    yielded += 1;
    if (yielded > MAX_VOCABULARY_ENTRIES) {
      throw new RangeError(
        `telemetry vocabulary ${label}: more than ${MAX_VOCABULARY_ENTRIES} entries`,
      );
    }
    if (!accepts(value)) {
      // The offending entry is deliberately not part of the message.
      throw new RangeError(
        `telemetry vocabulary ${label}: an entry is not an acceptable name`,
      );
    }
    set.add(value);
  }
  return set;
}

const isShortName = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 &&
  value.length <= MAX_VOCABULARY_ENTRY_LENGTH;

const member = (set: ReadonlySet<string>): Validator => (value) =>
  typeof value === "string" && set.has(value);

/**
 * Registered fields and the one shape each accepts. Durable ids correlate work
 * (a trace carries them, a metric label never does); nothing here is content.
 */
function registryFor(sets: Sets): ReadonlyMap<string, Validator> {
  return new Map<string, Validator>([
    ["bakery.run.id", isUuid],
    ["bakery.attempt.id", isUuid],
    ["bakery.job.id", isUuid],
    ["bakery.task.id", isUuid],
    ["bakery.repository.id", isUuid],
    [
      "bakery.step.key",
      (value) => {
        const id = qualifiedIdOfStepKey(value);
        return id !== undefined && sets.stepIds.has(id);
      },
    ],
    ["bakery.action", member(sets.actions)],
    ["bakery.provider.category", member(sets.providerCategories)],
    ["bakery.outcome", member(sets.outcomes)],
    ["bakery.actor.hash", isDigest],
    ["bakery.duration_ms", isDuration],
    ["bakery.retry.count", isCount],
    ["bakery.logical_attempt", isCount],
    ["bakery.lease.lost", isFlag],
  ]);
}

const noSets: Sets = {
  actions: new Set(),
  providerCategories: new Set(),
  outcomes: new Set(),
  stepIds: new Set(),
};

/** Every field name a record may carry. */
export const TELEMETRY_ATTRIBUTE_NAMES: readonly string[] = Object.freeze([
  ...registryFor(noSets).keys(),
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

/**
 * The filter. `withStepIds` returns the same filter for one run: its step ids
 * replace the ones this one holds, every other vocabulary is kept.
 */
export type TelemetryRedactor =
  & ((input: unknown) => RedactedTelemetryAttributes)
  & { readonly withStepIds: (stepIds: Iterable<string>) => TelemetryRedactor };

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
  let keys: string[];
  try {
    // Inside the try: `Array.isArray` itself throws on a revoked proxy.
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return nothing();
    }
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

function redactorFor(sets: Sets): TelemetryRedactor {
  const registry = registryFor(sets);
  const filter = (input: unknown) => redact(registry, input);
  return Object.assign(filter, {
    withStepIds: (stepIds: Iterable<string>) =>
      redactorFor({
        ...sets,
        stepIds: closedSet("stepIds", stepIds, isQualifiedStepId),
      }),
  });
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
): TelemetryRedactor {
  return redactorFor({
    actions: closedSet("actions", vocabulary.actions, isShortName),
    providerCategories: closedSet(
      "providerCategories",
      vocabulary.providerCategories,
      isShortName,
    ),
    outcomes: closedSet("outcomes", vocabulary.outcomes, isShortName),
    stepIds: closedSet("stepIds", vocabulary.stepIds, isQualifiedStepId),
  });
}

/**
 * The filter with no vocabulary: `bakery.action`, `bakery.provider.category`,
 * `bakery.outcome` and `bakery.step.key` are refused until a consumer builds
 * its own with {@link createTelemetryRedactor}.
 */
export const redactTelemetryAttributes: TelemetryRedactor =
  createTelemetryRedactor();
