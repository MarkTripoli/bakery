/**
 * What the Delivery page says, decided apart from the screen.
 *
 * The rule the page is built on is the one the server keeps: a value that
 * cannot be known is never a zero. Every function here is pure so that rule
 * can be tested without a browser. They return catalogue keys and plain data,
 * never sentences: the screen owns the words.
 */
import type { MessageKey } from "@bakery/i18n";
import type {
  MetricSeries,
  MetricSource,
  MetricsQuery,
} from "../../api/client.ts";

/** What a reader can open from the page: each figure names the records it counts. */
export const DELIVERY_SHOWS = [
  "merged",
  "opened",
  "open",
  "closed",
  "lines",
  "tasks",
] as const;
export type DeliveryShow = typeof DELIVERY_SHOWS[number];

export function isDeliveryShow(value: unknown): value is DeliveryShow {
  return typeof value === "string" &&
    (DELIVERY_SHOWS as readonly string[]).includes(value);
}

type MetricKey = MetricsQuery["metric"];

/**
 * The metric whose records a figure opens.
 *
 * "Merged" lists the records of the line-count metric, not of the merge count:
 * the two count the same merged pull requests, and the line-count rows carry the
 * lines (or the reason there are none) that the table shows beside each one.
 */
export const SHOW_METRIC: Readonly<Record<DeliveryShow, MetricKey>> = {
  merged: "prs.changedLines",
  opened: "prs.opened",
  tasks: "tasks.leadTimeHours",
  open: "prs.openAtCutoff",
  closed: "prs.closedUnmerged",
  lines: "prs.changedLines",
};

/** A number the page can show, or the fact that nobody can say. */
export type Figure =
  | { readonly kind: "value"; readonly value: number }
  | { readonly kind: "unknown" };

const UNKNOWN: Figure = { kind: "unknown" };

/**
 * A count over the whole window: pull requests merged, tasks delivered, pull
 * requests closed without merging.
 *
 * A series that was never read at all answers `unknown`, not 0: "nothing was
 * merged" and "nothing has been read yet" are different sentences.
 */
export function countFigure(series: MetricSeries | undefined): Figure {
  if (series === undefined || series.completeness === "unknown") {
    return UNKNOWN;
  }
  return { kind: "value", value: series.sampleCount };
}

/**
 * Pull requests still open as of the end of the window: the last bucket's
 * value, because "open at the cutoff" is a point in time, not a sum.
 */
export function openFigure(series: MetricSeries | undefined): Figure {
  if (series === undefined || series.completeness === "unknown") {
    return UNKNOWN;
  }
  const last = series.points.at(-1);
  return last === undefined || last.value === null
    ? UNKNOWN
    : { kind: "value", value: last.value };
}

export type SizeAndQuality = {
  readonly lines: {
    readonly total: number;
    readonly pullRequests: number;
  } | null;
  readonly uncounted: number;
};

export function sizeAndQualityOf(
  series: MetricSeries | undefined,
): SizeAndQuality {
  if (series === undefined || series.completeness === "unknown") {
    return { lines: null, uncounted: 0 };
  }
  return {
    lines: {
      total: series.points.reduce((sum, point) => sum + (point.value ?? 0), 0),
      pullRequests: series.sampleCount,
    },
    uncounted: series.missingCount,
  };
}

/** The line above the figures. Disconnected outranks stale outranks missing. */
export type Freshness =
  | { readonly kind: "complete"; readonly asOf: string | null }
  | {
    readonly kind: "missing";
    readonly asOf: string | null;
    /** Merged pull requests that could not be line-counted. */
    readonly unmeasured: number;
    /** Merged pull requests in the window, the denominator of the above. */
    readonly merged: number;
    /** Tasks whose time is missing. */
    readonly tasksMissing: number;
  }
  | {
    readonly kind: "disconnected";
    readonly repositoryIds: readonly string[];
    /** The earliest "since" among them; nothing after it is counted. */
    readonly since: string | null;
  }
  | { readonly kind: "stale"; readonly lastRead: string | null };

/** What the server said about the three series the line is read from. */
export type FreshnessInput = {
  readonly merged: MetricSeries | undefined;
  readonly lines: MetricSeries | undefined;
  readonly tasks: MetricSeries | undefined;
};

export function freshnessOf(input: FreshnessInput): Freshness {
  const repositories = input.merged?.repositories ?? [];
  const disconnected = repositories.filter((r) => r.state === "disconnected");
  if (disconnected.length > 0) {
    const sinces = disconnected.flatMap((r) =>
      r.since === null ? [] : [r.since]
    )
      .sort();
    return {
      kind: "disconnected",
      repositoryIds: disconnected.map((r) => r.repositoryId),
      since: sinces[0] ?? null,
    };
  }
  const asOf = input.merged?.lastSyncAt ?? null;
  if (repositories.some((r) => r.state === "stale")) {
    return { kind: "stale", lastRead: asOf };
  }
  const unmeasured = missingOf(input.lines, "no_diff_totals");
  const tasksMissing = input.tasks?.missingCount ?? 0;
  if (unmeasured > 0 || tasksMissing > 0) {
    return {
      kind: "missing",
      asOf,
      unmeasured,
      merged: (input.lines?.sampleCount ?? 0) + unmeasured,
      tasksMissing,
    };
  }
  return { kind: "complete", asOf };
}

function missingOf(series: MetricSeries | undefined, reason: string): number {
  return series?.missingReasons.find((entry) => entry.reason === reason)
    ?.count ?? 0;
}

/** The catalogue keys for why a record has a hole in it. */
export type MissingKey =
  | "delivery.missing.noOpenedTime"
  | "delivery.missing.noMergedTime"
  | "delivery.missing.noClosedTime"
  | "delivery.missing.noDiffTotals"
  | "delivery.missing.noLineCount"
  | "delivery.missing.lineCountBinary"
  | "delivery.missing.lineCountTruncated"
  | "delivery.missing.stillOpen"
  | "delivery.missing.other";

const MISSING_KEYS: Readonly<Record<string, MissingKey>> = {
  no_opened_time: "delivery.missing.noOpenedTime",
  no_merged_time: "delivery.missing.noMergedTime",
  no_closed_time: "delivery.missing.noClosedTime",
  no_diff_totals: "delivery.missing.noDiffTotals",
  no_line_count: "delivery.missing.noLineCount",
  line_count_binary: "delivery.missing.lineCountBinary",
  line_count_truncated: "delivery.missing.lineCountTruncated",
  still_open: "delivery.missing.stillOpen",
};

/**
 * The words for a missing reason, or null when the record has none.
 *
 * A reason the page has no word for says so rather than disappearing: a
 * record with a hole in it must never read as a complete one.
 */
export function missingKey(reason: string | null): MissingKey | null {
  if (reason === null) return null;
  return MISSING_KEYS[reason] ?? "delivery.missing.other";
}

/** Hours between two ISO times, or null when either is unknown or they run backwards. */
export function hoursBetween(
  from: string | null,
  to: string | null,
): number | null {
  if (from === null || to === null) return null;
  const span = Date.parse(to) - Date.parse(from);
  return Number.isFinite(span) && span >= 0 ? span / 3_600_000 : null;
}

/** One row of the records table, with everything the screen shows for it. */
export type RecordRow = {
  readonly key: string;
  readonly kind: "pullRequest" | "task";
  readonly title: string | null;
  readonly providerNumber: number | null;
  readonly repositoryId: string | null;
  /** The task a row opens in Bakery: a task itself, or the task a pull request delivers. */
  readonly taskId: string;
  readonly openedAt: string | null;
  readonly mergedAt: string | null;
  readonly closedAt: string | null;
  readonly requestedAt: string | null;
  readonly deliveredAt: string | null;
  /** Where a task's time stopped: a merged pull request or a completed run. */
  readonly deliveryPoint: "merged_pull_request" | "completed_run" | null;
  /** Hours of a task's lead time no record covers; null for a pull request or when unknown. */
  readonly unaccountedHours: number | null;
  /** Hours the task spent in each recorded wait; null when unknown or for a pull request. */
  readonly waitHours: Readonly<
    Record<"agentWorking" | "queue" | "review" | "person", number | null>
  >;
  /** Hours from open to merge, when both are known. */
  readonly openToMergeHours: number | null;
  /** Lines for a line-count row; hours for a task row; null when unknown. */
  readonly value: number | null;
  readonly missing: MissingKey | null;
};

function waitOf(source: MetricSource, category: string): number | null {
  return source.waits?.find((share) => share.category === category)?.hours ??
    null;
}

export function recordRow(source: MetricSource): RecordRow {
  return {
    key: source.id,
    kind: source.kind,
    title: source.title,
    providerNumber: source.providerNumber,
    repositoryId: source.repositoryId,
    taskId: source.kind === "task" ? source.id : source.taskId,
    openedAt: source.openedAt,
    mergedAt: source.mergedAt,
    closedAt: source.closedAt,
    requestedAt: source.requestedAt,
    deliveredAt: source.deliveredAt,
    deliveryPoint: source.deliveryPoint,
    unaccountedHours:
      source.waits?.find((share) => share.category === "unaccounted")?.hours ??
        null,
    waitHours: {
      agentWorking: waitOf(source, "agentWorking"),
      queue: waitOf(source, "queue"),
      review: waitOf(source, "review"),
      person: waitOf(source, "person"),
    },
    openToMergeHours: hoursBetween(source.openedAt, source.mergedAt),
    value: source.value,
    missing: missingKey(source.missingReason),
  };
}

/** Rows with something missing, for the "With something missing" filter. */
export function withSomethingMissing(rows: readonly RecordRow[]): RecordRow[] {
  return rows.filter((row) => row.missing !== null);
}

/** The catalogue keys for a length of time in words. */
export type DurationKey =
  | "delivery.duration.none"
  | "delivery.duration.lessThanMinute"
  | "delivery.duration.minutes"
  | "delivery.duration.hours"
  | "delivery.duration.hoursMinutes"
  | "delivery.duration.days"
  | "delivery.duration.daysHours";

export type DurationWords = {
  readonly key: DurationKey;
  readonly params: Readonly<Record<string, string>>;
};

/**
 * A length of time as a reader says it: "3 h 20 min", "2 d 4 h".
 *
 * Rounded to the minute and shown in the two largest units that matter, so a
 * lead time of a day and a half is not "36.0 hours" and a time of two days is
 * not a number of minutes. A time under a minute says so rather than "0".
 */
export function durationWords(hours: number): DurationWords {
  // An exact zero is "None": nothing, not a rounding of something small.
  if (hours === 0) return { key: "delivery.duration.none", params: {} };
  const total = Math.round(hours * 60);
  if (total < 1) return { key: "delivery.duration.lessThanMinute", params: {} };
  if (total < 60) {
    return {
      key: "delivery.duration.minutes",
      params: { minutes: String(total) },
    };
  }
  const wholeHours = Math.floor(total / 60);
  const minutes = total % 60;
  if (wholeHours < 48) {
    return minutes === 0
      ? {
        key: "delivery.duration.hours",
        params: { hours: String(wholeHours) },
      }
      : {
        key: "delivery.duration.hoursMinutes",
        params: { hours: String(wholeHours), minutes: String(minutes) },
      };
  }
  const days = Math.floor(wholeHours / 24);
  const rest = wholeHours % 24;
  return rest === 0
    ? { key: "delivery.duration.days", params: { days: String(days) } }
    : {
      key: "delivery.duration.daysHours",
      params: { days: String(days), hours: String(rest) },
    };
}

/** The parts of a task's lead time, in the order the bar draws them. */
export const TIME_PARTS = [
  "agentWorking",
  "queue",
  "review",
  "person",
  "blocked",
  "unaccounted",
] as const;
export type TimePartId = typeof TIME_PARTS[number];

/** One part of the bar: a category and the hours it holds. Never zero, never unknown. */
export type TimePart = {
  readonly id: TimePartId;
  readonly hours: number;
};

/** What the lead-time summary says, ready for the screen. */
export type LeadTime = {
  /** Tasks in the summary. */
  readonly count: number;
  readonly median: number | null;
  readonly p90: number | null;
  /** Parts that hold time, in drawing order; they add up to `totalHours`. */
  readonly parts: readonly TimePart[];
  readonly totalHours: number;
  /**
   * Whether Blocked time is known. Bakery keeps no history of when a task was
   * blocked, so it is unknown and is a line under the bar, never a part of it.
   */
  readonly blockedKnown: boolean;
  /** Which delivery point the tasks reached: all at a merge, all at a run, or both. */
  readonly point: "merge" | "run" | "mixed";
  /** Tasks that reached a completed run with no pull request. */
  readonly runCount: number;
  /** Tasks left out of the summary because their time is missing. */
  readonly leftOut: number;
};

/**
 * The lead-time summary of the tasks delivered in the window, or null when
 * there are none to summarise. Hours that are null stay out of the bar: a
 * category with no time is absent, and the bar still adds up to its total.
 */
export function leadTimeOf(series: MetricSeries | undefined): LeadTime | null {
  const summary = series?.summary ?? null;
  if (summary === null) return null;
  const merged =
    summary.deliveryPoints.find((entry) =>
      entry.deliveryPoint === "merged_pull_request"
    )?.count ?? 0;
  const runs =
    summary.deliveryPoints.find((entry) =>
      entry.deliveryPoint === "completed_run"
    )?.count ?? 0;
  const count = merged + runs;
  if (count === 0) return null;
  const hoursOf = new Map(
    summary.breakdown.map((share) => [share.category, share.hours]),
  );
  const parts = TIME_PARTS.flatMap((id): TimePart[] => {
    const hours = hoursOf.get(id) ?? null;
    return hours !== null && hours > 0 ? [{ id, hours }] : [];
  });
  return {
    count,
    median: summary.median,
    p90: summary.p90,
    parts,
    totalHours: parts.reduce((sum, part) => sum + part.hours, 0),
    blockedKnown: (hoursOf.get("blocked") ?? null) !== null,
    point: runs === 0 ? "merge" : merged === 0 ? "run" : "mixed",
    runCount: runs,
    leftOut: series?.missingCount ?? 0,
  };
}

const RULE_KEYS = {
  merged: "delivery.records.rule.merged",
  tasks: "delivery.records.rule.tasks",
  open: "delivery.records.rule.open",
  opened: "delivery.records.rule.opened",
  lines: "delivery.records.rule.merged",
  closed: "delivery.records.rule.closed",
} as const satisfies Record<DeliveryShow, MessageKey>;

const RULE_KEYS_NO_VERSION = {
  merged: "delivery.records.rule.merged.noVersion",
  tasks: "delivery.records.rule.tasks.noVersion",
  open: "delivery.records.rule.open.noVersion",
  opened: "delivery.records.rule.opened.noVersion",
  lines: "delivery.records.rule.merged.noVersion",
  closed: "delivery.records.rule.closed.noVersion",
} as const satisfies Record<DeliveryShow, MessageKey>;

export function ruleKey(
  show: DeliveryShow,
  version: string | null,
): MessageKey {
  const keys = version === null ? RULE_KEYS_NO_VERSION : RULE_KEYS;
  return keys[show];
}

export type ChartPoint = Readonly<{ at: string; value: number | null }>;

export type ChartSegment = readonly Readonly<{ at: string; value: number }>[];

export type ChartGap = Readonly<{ from: string; to: string; points: number }>;

export function chartSegments(
  points: readonly ChartPoint[],
): readonly ChartSegment[] {
  const segments: { at: string; value: number }[][] = [];
  let run: { at: string; value: number }[] = [];
  for (const point of points) {
    if (point.value === null) {
      if (run.length > 0) segments.push(run);
      run = [];
      continue;
    }
    run.push({ at: point.at, value: point.value });
  }
  if (run.length > 0) segments.push(run);
  return segments;
}

export function chartGaps(points: readonly ChartPoint[]): readonly ChartGap[] {
  const gaps: { from: string; to: string; points: number }[] = [];
  let open: { from: string; to: string; points: number } | null = null;
  for (const point of points) {
    if (point.value === null) {
      open = open === null
        ? { from: point.at, to: point.at, points: 1 }
        : { from: open.from, to: point.at, points: open.points + 1 };
      continue;
    }
    if (open !== null) gaps.push(open);
    open = null;
  }
  if (open !== null) gaps.push(open);
  return gaps;
}

export function chartMissingDays(
  points: readonly ChartPoint[],
  to: string,
): number {
  const upper = Date.parse(to);
  let missingMilliseconds = 0;
  for (const [index, point] of points.entries()) {
    if (point.value !== null) continue;
    const next = points[index + 1];
    const end = Math.min(
      next === undefined ? upper : Date.parse(next.at),
      upper,
    );
    missingMilliseconds += Math.max(0, end - Date.parse(point.at));
  }
  return Math.ceil(missingMilliseconds / 86_400_000);
}

export function chartMaximum(points: readonly ChartPoint[]): number {
  let maximum = 0;
  for (const point of points) {
    if (point.value !== null && point.value > maximum) maximum = point.value;
  }
  return maximum;
}
