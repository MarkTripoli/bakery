/**
 * A metrics registry whose size is fixed by its definition.
 *
 * A metric label is the one place a telemetry value becomes a dimension, and a
 * dimension that can take an unbounded set of values is the cardinality
 * explosion that takes a metrics backend down. So labels are closed: each lists
 * its values when the registry is made, a value outside the list lands in one
 * shared `other` bucket, and the number of series the registry can ever hold is
 * the product of its labels' value counts, checked at creation. Run, attempt,
 * job and other durable ids are never labels; they belong in traces, where a
 * high-cardinality value is cheap.
 *
 * Recording never throws and never blocks: the registry sits on the paths of
 * lease renewal, completion and settlement, so a hostile or mistaken call costs
 * a counted overflow and nothing else.
 */

/** Value every label has implicitly, for anything its list does not name. */
export const OTHER_LABEL_VALUE = "other";

/** Most metrics one registry may define. */
export const MAX_METRICS = 64;

/** Most labels one metric may have. */
export const MAX_METRIC_LABELS = 4;

/** Most values one label may list, not counting `other`. */
export const MAX_LABEL_VALUES = 32;

/** Most series one metric may have, `other` buckets included. */
export const MAX_SERIES_PER_METRIC = 256;

/** Most series a whole registry may have. */
export const MAX_TOTAL_SERIES = 2048;

/** Longest help text. */
const MAX_HELP_LENGTH = 200;

const METRIC_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const LABEL_NAME = /^[a-z][a-z0-9_]{1,31}$/;
// At most 24 characters, so a 32-character hex id or a UUID can never be a value.
const LABEL_VALUE = /^[a-z][a-z0-9_]{0,23}$/;

/** What kind of number a metric holds. */
export type MetricKind = "counter" | "gauge";

export type MetricSpec = {
  readonly kind: MetricKind;
  /** What the number means; static text, shown by whatever exposes it. */
  readonly help: string;
  /** Label name to the values it may take. Anything else becomes `other`. */
  readonly labels?: Readonly<Record<string, readonly string[]>>;
};

export type MetricSpecs = Readonly<Record<string, MetricSpec>>;

export type MetricSample = {
  readonly name: string;
  readonly kind: MetricKind;
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
};

export type MetricsRegistry = {
  /** Adds `by` (default 1, finite and not negative) to a counter series. */
  inc(name: string, labels?: unknown, by?: unknown): void;
  /** Sets a gauge series to a finite number. */
  set(name: string, labels: unknown, value: unknown): void;
  /** Every series touched so far, sorted, as copies. */
  snapshot(): MetricSample[];
  /** Calls refused or folded into `other`; the registry's own error count. */
  overflow(): number;
  /**
   * Changes whenever a snapshot would differ: a series gained a value or
   * appeared. Equal versions mean equal snapshots, so one can be shared.
   */
  version(): number;
};

type Definition = {
  readonly name: string;
  readonly kind: MetricKind;
  readonly labels: ReadonlyArray<{
    readonly name: string;
    readonly values: ReadonlySet<string>;
  }>;
};

type Series = {
  readonly definition: Definition;
  readonly labels: Readonly<Record<string, string>>;
  value: number;
};

function invalid(what: string): never {
  // The offending text is deliberately not part of the message.
  throw new RangeError(`telemetry metrics: ${what}`);
}

function define(name: string, spec: MetricSpec): Definition {
  if (!METRIC_NAME.test(name)) invalid("a metric name is not acceptable");
  if (spec?.kind !== "counter" && spec?.kind !== "gauge") {
    invalid("a metric kind is not counter or gauge");
  }
  if (
    typeof spec.help !== "string" || spec.help.trim().length === 0 ||
    spec.help.length > MAX_HELP_LENGTH
  ) invalid("a metric needs a short help text");
  const entries = Object.entries(spec.labels ?? {});
  if (entries.length > MAX_METRIC_LABELS) {
    invalid("a metric has too many labels");
  }
  let series = 1;
  const labels = entries.map(([labelName, values]) => {
    if (!LABEL_NAME.test(labelName)) invalid("a label name is not acceptable");
    if (
      !Array.isArray(values) || values.length === 0 ||
      values.length > MAX_LABEL_VALUES
    ) invalid("a label needs between 1 and the maximum number of values");
    const set = new Set<string>();
    for (const value of values) {
      if (
        typeof value !== "string" || !LABEL_VALUE.test(value) ||
        value === OTHER_LABEL_VALUE || set.has(value)
      ) invalid("a label value is not acceptable");
      set.add(value);
    }
    series *= set.size + 1;
    return { name: labelName, values: set };
  });
  if (series > MAX_SERIES_PER_METRIC) invalid("a metric has too many series");
  return { name, kind: spec.kind, labels };
}

/** Number of series a definition can hold. */
function seriesOf(definition: Definition): number {
  return definition.labels.reduce((n, label) => n * (label.values.size + 1), 1);
}

const MAX_GAUGE = Number.MAX_SAFE_INTEGER;

export function createMetricsRegistry(specs: MetricSpecs): MetricsRegistry {
  const entries = Object.entries(specs ?? {});
  if (entries.length > MAX_METRICS) invalid("too many metrics");
  const definitions = new Map<string, Definition>();
  let total = 0;
  for (const [name, spec] of entries) {
    const definition = define(name, spec);
    total += seriesOf(definition);
    definitions.set(name, definition);
  }
  if (total > MAX_TOTAL_SERIES) invalid("too many series across all metrics");

  const series = new Map<string, Series>();
  let overflow = 0;
  let version = 0;

  /** Resolves labels to the series they name, or counts why they cannot. */
  function seriesFor(
    name: unknown,
    kind: MetricKind,
    labels: unknown,
  ): Series | undefined {
    const definition = typeof name === "string"
      ? definitions.get(name)
      : undefined;
    if (!definition || definition.kind !== kind) {
      overflow += 1;
      return undefined;
    }
    const resolved: Record<string, string> = {};
    const known = new Set(definition.labels.map((label) => label.name));
    let supplied: Set<string> | undefined;
    try {
      if (typeof labels === "object" && labels !== null) {
        supplied = new Set(Object.keys(labels));
      }
    } catch {
      supplied = undefined;
    }
    if (supplied) {
      for (const key of supplied) {
        if (!known.has(key)) overflow += 1;
      }
    }
    for (const label of definition.labels) {
      let value: unknown;
      try {
        if (supplied?.has(label.name)) {
          value = (labels as Record<string, unknown>)[label.name];
        }
      } catch {
        value = undefined;
      }
      if (typeof value === "string" && label.values.has(value)) {
        resolved[label.name] = value;
      } else {
        resolved[label.name] = OTHER_LABEL_VALUE;
        overflow += 1;
      }
    }
    const key = `${definition.name}\u0000${
      definition.labels.map((label) => resolved[label.name]).join("\u0000")
    }`;
    let existing = series.get(key);
    if (!existing) {
      existing = { definition, labels: resolved, value: 0 };
      series.set(key, existing);
      version += 1;
    }
    return existing;
  }

  return {
    inc(name, labels, by = 1) {
      try {
        if (typeof by !== "number" || !Number.isFinite(by) || by < 0) {
          overflow += 1;
          return;
        }
        const target = seriesFor(name, "counter", labels);
        if (target) {
          const next = Math.min(target.value + by, MAX_GAUGE);
          if (next !== target.value) {
            target.value = next;
            version += 1;
          }
        }
      } catch {
        overflow += 1;
      }
    },

    set(name, labels, value) {
      try {
        if (
          typeof value !== "number" || !Number.isFinite(value) ||
          Math.abs(value) > MAX_GAUGE
        ) {
          overflow += 1;
          return;
        }
        const target = seriesFor(name, "gauge", labels);
        if (target && target.value !== value) {
          target.value = value;
          version += 1;
        }
      } catch {
        overflow += 1;
      }
    },

    snapshot() {
      return [...series.values()]
        .map((entry) => ({
          name: entry.definition.name,
          kind: entry.definition.kind,
          labels: { ...entry.labels },
          value: entry.value,
        }))
        .sort((a, b) =>
          a.name === b.name
            ? JSON.stringify(a.labels) < JSON.stringify(b.labels) ? -1 : 1
            : a.name < b.name
            ? -1
            : 1
        );
    },

    overflow: () => overflow,

    version: () => version,
  };
}
