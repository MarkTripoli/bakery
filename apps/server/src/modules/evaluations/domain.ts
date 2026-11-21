/**
 * Evaluation batches: result states, coverage, the release gate and batch
 * comparison (chapter 23, issue #44). Pure functions over the stored rows; the
 * database holds facts and TypeScript decides, so nothing here is a rule
 * enforced in SQL.
 *
 * A batch measures one target (and optionally a baseline) on one immutable
 * dataset with pinned scorer revisions. Every required case x scorer x side
 * is a result row from admission on, so a case that never ran is a row in
 * state "missing", never an absence. Nothing is ever synthesized: an error,
 * an unscored, canceled, skipped or missing result has no score, keeps its
 * reason, counts in coverage, and stops a required gate from passing.
 */

export const ResultState = Object.freeze(
  {
    Passed: "passed",
    Failed: "failed",
    Error: "error",
    Unscored: "unscored",
    Canceled: "canceled",
    Skipped: "skipped",
    Missing: "missing",
  } as const,
);
export type ResultState = typeof ResultState[keyof typeof ResultState];
export const RESULT_STATES: readonly ResultState[] = Object.values(ResultState);

/** A state with a measurement: only these carry a score. */
export function isMeasured(state: ResultState): boolean {
  return state === ResultState.Passed || state === ResultState.Failed;
}

export const BatchState = Object.freeze(
  {
    Queued: "queued",
    Running: "running",
    Completed: "completed",
    CompletedWithErrors: "completed_with_errors",
    Canceled: "canceled",
    Failed: "failed",
  } as const,
);
export type BatchState = typeof BatchState[keyof typeof BatchState];

export type Role = "candidate" | "baseline";

export type ResultFact = Readonly<{
  role: Role;
  caseId: string;
  caseRevision: number;
  scorerId: string;
  scorerRevision: number;
  repetition: number;
  state: ResultState;
  score: number | null;
  required: boolean;
}>;

export type StateCounts = Record<ResultState, number>;

export function emptyCounts(): StateCounts {
  return Object.fromEntries(RESULT_STATES.map((s) => [s, 0])) as StateCounts;
}

/** Counts per state and measured coverage of the required results of one side. */
export function coverage(
  results: readonly ResultFact[],
  role: Role = "candidate",
) {
  const mine = results.filter((r) => r.role === role && r.required);
  const counts = emptyCounts();
  for (const r of mine) counts[r.state] += 1;
  const measured = counts.passed + counts.failed;
  return { required: mine.length, measured, counts };
}

/** A batch's state once nothing is still to run, from its results. */
export function settledState(
  results: readonly ResultFact[],
  canceled: boolean,
): BatchState {
  if (canceled) return BatchState.Canceled;
  const required = results.filter((r) => r.required);
  if (required.length === 0) return BatchState.Failed;
  return required.every((r) => isMeasured(r.state))
    ? BatchState.Completed
    : BatchState.CompletedWithErrors;
}

export type GateRule = Readonly<{
  /** Every required result must pass (failed fails the gate). */
  requireAllPassed: boolean;
  /** Smallest pass rate over required measured results, 0..1. */
  minPassRate: number | null;
}>;

export type GateBlocker = Readonly<{
  caseId: string;
  scorerId: string;
  state: ResultState;
}>;

export type GateDecision = Readonly<{
  decision: "met" | "not_met" | "cannot_be_judged";
  rule: string;
  blockers: GateBlocker[];
}>;

/** The rule as a sentence the page can show. */
export function ruleSentence(rule: GateRule): string {
  const parts = ["Every required case and scorer has a measured result"];
  if (rule.requireAllPassed) parts.push("every one passed");
  if (rule.minPassRate !== null) {
    parts.push(`at least ${Math.round(rule.minPassRate * 100)}% passed`);
  }
  return parts.join(", and ") + ".";
}

/**
 * The release gate over the candidate side. It cannot be judged while any
 * required result is unmeasured (error, unscored, canceled, skipped or
 * missing), or while the batch is canceled or still running; an empty batch
 * cannot pass. Otherwise it is met or not met by the rule.
 */
export function judgeGate(
  results: readonly ResultFact[],
  rule: GateRule,
  batchState: BatchState,
): GateDecision {
  const sentence = ruleSentence(rule);
  const required = results.filter((r) => r.role === "candidate" && r.required);
  const unmeasured = required.filter((r) => !isMeasured(r.state));
  if (
    required.length === 0 || unmeasured.length > 0 ||
    batchState === BatchState.Canceled || batchState === BatchState.Queued ||
    batchState === BatchState.Running || batchState === BatchState.Failed
  ) {
    return {
      decision: "cannot_be_judged",
      rule: sentence,
      blockers: unmeasured.map(blocker),
    };
  }
  const failed = required.filter((r) => r.state === ResultState.Failed);
  const rate = (required.length - failed.length) / required.length;
  const ok = (!rule.requireAllPassed || failed.length === 0) &&
    (rule.minPassRate === null || rate >= rule.minPassRate);
  return {
    decision: ok ? "met" : "not_met",
    rule: sentence,
    blockers: ok ? [] : failed.map(blocker),
  };
}

function blocker(r: ResultFact): GateBlocker {
  return { caseId: r.caseId, scorerId: r.scorerId, state: r.state };
}

export type BatchPins = Readonly<{
  datasetId: string;
  datasetDigest: string;
  cases: readonly { caseId: string; caseRevision: number }[];
  scorers: readonly { scorerId: string; scorerRevision: number }[];
}>;

export type IncompatibleReason =
  | "different_dataset"
  | "different_case_revision"
  | "different_scorer_version";

/**
 * Whether two batches can be compared: the same dataset revision, the same
 * case revisions and the same scorer revisions. The first difference found
 * is the reason; nothing is compared across it.
 */
export function compatibility(
  left: BatchPins,
  right: BatchPins,
): { compatible: true } | { compatible: false; reason: IncompatibleReason } {
  if (
    left.datasetId !== right.datasetId ||
    left.datasetDigest !== right.datasetDigest
  ) {
    // Same dataset, other revision: say which part differs.
    const leftCases = new Map(
      left.cases.map((c) => [c.caseId, c.caseRevision]),
    );
    const shared = right.cases.some((c) => leftCases.has(c.caseId));
    const revisionsDiffer = right.cases.some((c) =>
      leftCases.has(c.caseId) && leftCases.get(c.caseId) !== c.caseRevision
    );
    if (shared && revisionsDiffer) {
      return { compatible: false, reason: "different_case_revision" };
    }
    return { compatible: false, reason: "different_dataset" };
  }
  const key = (s: { scorerId: string; scorerRevision: number }) =>
    s.scorerId + "@" + s.scorerRevision;
  const a = new Set(left.scorers.map(key));
  const b = new Set(right.scorers.map(key));
  if (a.size !== b.size || [...a].some((k) => !b.has(k))) {
    return { compatible: false, reason: "different_scorer_version" };
  }
  return { compatible: true };
}

export type MeasureComparison = Readonly<{
  scorerId: string;
  left: { passRate: number | null; cases: number };
  right: { passRate: number | null; cases: number };
  change: number | null;
}>;

export type CaseComparison = Readonly<{
  caseId: string;
  scorerId: string;
  left: ResultState;
  right: ResultState;
}>;

/**
 * Compares the candidate sides of two compatible batches: per scorer, both
 * pass rates over measured results with their case counts, and the change
 * only when both sides measured something; per case and scorer, both states;
 * and the cases one side has and the other lacks, listed by side.
 */
export function compareBatches(
  left: readonly ResultFact[],
  right: readonly ResultFact[],
) {
  const side = (results: readonly ResultFact[]) =>
    results.filter((r) => r.role === "candidate" && r.repetition === 1);
  const l = side(left);
  const r = side(right);
  const id = (x: ResultFact) => x.caseId + "|" + x.scorerId;
  const rightById = new Map(r.map((x) => [id(x), x]));
  const leftById = new Map(l.map((x) => [id(x), x]));
  const cases: CaseComparison[] = [];
  const onlyLeft: { caseId: string; scorerId: string }[] = [];
  for (const x of l) {
    const y = rightById.get(id(x));
    if (y) {
      cases.push({
        caseId: x.caseId,
        scorerId: x.scorerId,
        left: x.state,
        right: y.state,
      });
    } else onlyLeft.push({ caseId: x.caseId, scorerId: x.scorerId });
  }
  const onlyRight = r.filter((y) => !leftById.has(id(y)))
    .map((y) => ({ caseId: y.caseId, scorerId: y.scorerId }));
  const scorers = [...new Set([...l, ...r].map((x) => x.scorerId))].sort();
  const rate = (results: readonly ResultFact[], scorerId: string) => {
    const measured = results.filter((x) =>
      x.scorerId === scorerId && isMeasured(x.state)
    );
    return {
      passRate: measured.length === 0
        ? null
        : measured.filter((x) => x.state === ResultState.Passed).length /
          measured.length,
      cases: measured.length,
    };
  };
  const measures: MeasureComparison[] = scorers.map((scorerId) => {
    const a = rate(l, scorerId);
    const b = rate(r, scorerId);
    return {
      scorerId,
      left: a,
      right: b,
      change: a.passRate === null || b.passRate === null
        ? null
        : b.passRate - a.passRate,
    };
  });
  return { measures, cases, unpaired: { onlyLeft, onlyRight } };
}

/**
 * The gate from per-state counts plus the blockers read for them: the same
 * answer as judgeGate, for a batch read that does not load every result.
 */
export function judgeGateCounts(
  input: Readonly<{
    required: number;
    counts: StateCounts;
    blockers: readonly GateBlocker[];
  }>,
  rule: GateRule,
  batchState: BatchState,
): GateDecision {
  const sentence = ruleSentence(rule);
  const measured = input.counts.passed + input.counts.failed;
  const unmeasured = input.required - measured;
  if (
    input.required === 0 || unmeasured > 0 ||
    batchState === BatchState.Canceled || batchState === BatchState.Queued ||
    batchState === BatchState.Running || batchState === BatchState.Failed
  ) {
    return {
      decision: "cannot_be_judged",
      rule: sentence,
      blockers: input.blockers.filter((b) => !isMeasured(b.state)),
    };
  }
  const rate = input.counts.passed / input.required;
  const ok = (!rule.requireAllPassed || input.counts.failed === 0) &&
    (rule.minPassRate === null || rate >= rule.minPassRate);
  return {
    decision: ok ? "met" : "not_met",
    rule: sentence,
    blockers: ok
      ? []
      : input.blockers.filter((b) => b.state === ResultState.Failed),
  };
}

/** A batch's state from its stored flags and its required results' counts. */
export function batchStateOf(
  input: Readonly<{
    canceled: boolean;
    required: number;
    counts: StateCounts;
    attempted: boolean;
  }>,
): BatchState {
  if (input.canceled) return BatchState.Canceled;
  if (input.required === 0) return BatchState.Failed;
  if (input.counts.missing > 0) {
    return input.attempted ? BatchState.Running : BatchState.Queued;
  }
  return input.counts.passed + input.counts.failed === input.required
    ? BatchState.Completed
    : BatchState.CompletedWithErrors;
}
