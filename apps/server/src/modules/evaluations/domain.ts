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

// ------------------------------------------------- versioned pins (issue #41)

/** What a batch may measure: an exact version of one of these. */
export const PIN_KINDS = Object.freeze(
  [
    "agentVersion",
    "workflowVersion",
    "skillVersion",
    "profileVersion",
    "artifactVersion",
  ] as const,
);
export type PinKind = typeof PIN_KINDS[number];
export type Pin = Readonly<{ kind: PinKind; id: string; version: number }>;

const PIN_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A pin names one exact version, so a repeated run measures the same thing:
 * its kind, the id and the version number, and nothing else. A pin without a
 * version, with an unknown kind or with extra keys is refused rather than
 * measured as something near it.
 */
export function validatePin(
  pin: unknown,
): { ok: true; pin: Pin } | { ok: false; reason: string } {
  if (typeof pin !== "object" || pin === null || Array.isArray(pin)) {
    return { ok: false, reason: "pin_not_an_object" };
  }
  const record = pin as Record<string, unknown>;
  if (Object.keys(record).some((k) => !["kind", "id", "version"].includes(k))) {
    return { ok: false, reason: "pin_unknown_field" };
  }
  if (
    typeof record.kind !== "string" ||
    !(PIN_KINDS as readonly string[]).includes(record.kind)
  ) return { ok: false, reason: "pin_kind_unknown" };
  if (typeof record.id !== "string" || !PIN_UUID.test(record.id)) {
    return { ok: false, reason: "pin_id_invalid" };
  }
  if (
    typeof record.version !== "number" ||
    !Number.isSafeInteger(record.version) ||
    record.version < 1
  ) return { ok: false, reason: "pin_version_required" };
  return {
    ok: true,
    pin: {
      kind: record.kind as PinKind,
      // The same version has one spelling: a UUID's case does not name a
      // different one, and the pin digest hashes this spelling.
      id: record.id.toLowerCase(),
      version: record.version,
    },
  };
}

export type ScorerKind = "deterministic" | "model";

/**
 * Which pinned scorers are optional. A deterministic check is never optional
 * and a required check is never sampled away; only a model scorer can be
 * marked optional, and only if it is one of the batch's scorers.
 */
export function optionalScorerProblem(
  scorers: readonly { scorerId: string; evaluatorType: string }[],
  optionalIds: readonly string[],
): { field: string; reason: string } | null {
  const byId = new Map(scorers.map((s) => [s.scorerId, s]));
  for (const id of optionalIds) {
    const scorer = byId.get(id);
    if (scorer === undefined) {
      return {
        field: "optionalScorerIds",
        reason: "optional_scorer_not_pinned",
      };
    }
    if (scorer.evaluatorType === "deterministic") {
      return {
        field: "optionalScorerIds",
        reason: "deterministic_scorer_required",
      };
    }
  }
  if (new Set(optionalIds).size !== optionalIds.length) {
    return { field: "optionalScorerIds", reason: "duplicate_scorer" };
  }
  return null;
}

/**
 * Everything that makes two batches measure the same thing, in a shape whose
 * canonical JSON is hashed: the dataset revision, both pins, the scorer
 * revisions with whether each is required, and the repetitions. The budget is
 * left out: a limit does not change what is measured.
 */
export function pinSpec(
  input: Readonly<{
    datasetDigest: string;
    candidate: unknown;
    baseline: unknown | null;
    scorers: readonly {
      scorerId: string;
      scorerRevision: number;
      required: boolean;
    }[];
    repetitions: number;
  }>,
) {
  return {
    datasetDigest: input.datasetDigest,
    candidate: input.candidate,
    baseline: input.baseline,
    scorers: [...input.scorers]
      .map((s) => ({
        scorerId: s.scorerId,
        scorerRevision: s.scorerRevision,
        required: s.required,
      }))
      .sort((a, b) => a.scorerId.localeCompare(b.scorerId)),
    repetitions: input.repetitions,
  };
}

// ------------------------------------------------------- the corpus report

/** What a result's history says, for the report; one per candidate result. */
export type ReportFact = Readonly<{
  state: ResultState;
  attempts: number;
  /** At least one attempt at it was interrupted before it measured anything. */
  interrupted: boolean;
  /** How many results share this history; 1 when absent. */
  count?: number;
}>;

export type CorpusReport = Readonly<{
  total: number;
  attempted: number;
  passed: number;
  failed: number;
  /** Attempted, but the latest attempt measured nothing: the outcome is not known. */
  unknown: number;
  /** Never attempted. Not a failure and not a pass. */
  unrun: number;
  interrupted: number;
  recovered: number;
  passedOfAttempted: number | null;
  failedOfAttempted: number | null;
  recoveredOfInterrupted: number | null;
}>;

/**
 * The offline corpus report over candidate results: attempted, passed,
 * failed, unknown and unrun, and of those attempted the passed and failed
 * shares; of those interrupted the share that recovered to a measurement. A
 * share with nothing to divide is null, never zero: no result is not a zero
 * rate, and an unknown or unrun result is counted on its own, not as a failure.
 */
export function corpusReport(facts: readonly ReportFact[]): CorpusReport {
  let attempted = 0, passed = 0, failed = 0, unknown = 0;
  let interrupted = 0, recovered = 0;
  let total = 0;
  for (const f of facts) {
    const n = f.count ?? 1;
    total += n;
    if (f.attempts > 0) {
      attempted += n;
      if (f.state === ResultState.Passed) passed += n;
      else if (f.state === ResultState.Failed) failed += n;
      else unknown += n;
    }
    if (f.interrupted) {
      interrupted += n;
      if (isMeasured(f.state)) recovered += n;
    }
  }
  const share = (n: number, of: number) => of === 0 ? null : n / of;
  return {
    total,
    attempted,
    passed,
    failed,
    unknown,
    unrun: total - attempted,
    interrupted,
    recovered,
    passedOfAttempted: share(passed, attempted),
    failedOfAttempted: share(failed, attempted),
    recoveredOfInterrupted: share(recovered, interrupted),
  };
}

/**
 * The state an attempt leaves on its result. An interrupted attempt measured
 * nothing, so its result is an error with the reason; every other state is
 * its own.
 */
export function resultStateOfAttempt(
  state: ResultState | "interrupted",
): ResultState {
  return state === "interrupted" ? ResultState.Error : state;
}

// ----------------------------------------- the model-evaluation budget (#41)

/** How a model call's cost is known, as the usage ledger records it. */
export type UsageMeasurement = "reported" | "estimated" | "unknown";

/**
 * What the usage ledger says about the attempts of one scorer: how many
 * attempts have this measurement and, for reported and estimated, their total
 * cost as a decimal string. An unknown cost carries none: it is not zero.
 */
export type UsageGroup = Readonly<{
  measurement: UsageMeasurement;
  count: number;
  costUsd: string | null;
  /** When the earliest of these attempts was recorded, as an ISO timestamp. */
  since?: string | null;
}>;

export type BudgetStatus = "none" | "within" | "exhausted" | "unsettled";

export type BudgetReport = Readonly<{
  limitUsd: string | null;
  /** Reported and estimated cost so far. Unknown costs are not in it. */
  settledUsd: string;
  /** The part of settledUsd that was estimated, not reported: not a bill. */
  estimatedUsd: string;
  /** Model attempts whose cost is not known: provider failure, timeout or no receipt. */
  unknownCount: number;
  status: BudgetStatus;
  /** True when no new model attempt will start: exhausted or unsettled. */
  blocksNewAttempts: boolean;
  /** When the earliest still-unknown cost was recorded; null when none is unknown. */
  oldestUnknownAt: string | null;
}>;

const MICRO = 1_000_000;

/** A decimal USD string as whole micro-dollars; null when it is not one. */
export function toMicroUsd(value: string | number | null): number | null {
  if (value === null) return null;
  const text = String(value).trim();
  const match = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(text);
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(6, "0"));
  const micro = whole * MICRO + fraction;
  return Number.isSafeInteger(micro) ? micro : null;
}

export function formatMicroUsd(micro: number): string {
  const whole = Math.floor(micro / MICRO);
  return whole + "." + String(micro - whole * MICRO).padStart(6, "0");
}

/**
 * The budget of a batch's model evaluation, separate from any run's budget:
 * the limit, what was settled, and how many attempts cost an unknown amount.
 * Unknown cost is never zero and never releases the budget: with one in the
 * set the batch cannot say it is within its limit, so it is unsettled until
 * the ledger reconciles it. Exhausted wins: a settled total at or over the
 * limit is over it whatever else is unknown.
 */
export function budgetReport(
  limitUsd: string | null,
  groups: readonly UsageGroup[],
): BudgetReport {
  let settled = 0;
  let estimated = 0;
  let unknown = 0;
  let oldestUnknownAt: string | null = null;
  for (const g of groups) {
    if (g.measurement === "unknown") {
      unknown += g.count;
      if (
        g.since != null &&
        (oldestUnknownAt === null ||
          new Date(g.since).getTime() < new Date(oldestUnknownAt).getTime())
      ) oldestUnknownAt = g.since;
      continue;
    }
    const cost = toMicroUsd(g.costUsd) ?? 0;
    settled += cost;
    if (g.measurement === "estimated") estimated += cost;
  }
  const limit = toMicroUsd(limitUsd);
  const status: BudgetStatus = limit === null
    ? "none"
    : settled >= limit
    ? "exhausted"
    : unknown > 0
    ? "unsettled"
    : "within";
  return {
    limitUsd: limit === null ? null : formatMicroUsd(limit),
    settledUsd: formatMicroUsd(settled),
    estimatedUsd: formatMicroUsd(estimated),
    unknownCount: unknown,
    status,
    blocksNewAttempts: status === "exhausted" || status === "unsettled",
    oldestUnknownAt,
  };
}

/**
 * Whether another model attempt may start: not past the limit and not with an
 * unknown cost outstanding, since the batch could not show it stayed within.
 * A batch with no limit is not stopped by the budget.
 */
export function modelAttemptAllowed(report: BudgetReport): boolean {
  return !report.blocksNewAttempts;
}

/**
 * The usage group of an attempt's ledger row. A model attempt with no row at
 * all is unknown, never free; a deterministic check has no cost and no group.
 */
export function usageGroupOf(
  evaluatorType: string,
  row:
    | Readonly<{ measurement: UsageMeasurement; costUsd: string | null }>
    | null,
): { measurement: UsageMeasurement; costUsd: string | null } | null {
  if (evaluatorType === "deterministic") return null;
  return row ?? { measurement: "unknown", costUsd: null };
}

// ------------------------------------------ the local corpus runner (#41)

/** Most results one local run call settles; call again to continue. */
export const LOCAL_RUN_MAX_RESULTS = 2000;
/** Largest recorded output a local check reads; a larger one is an error, not a pass. */
export const LOCAL_RUN_MAX_INPUT_BYTES = 1_048_576;

export const LOCAL_RUN_SKIP_MODEL =
  "A local corpus run scores recorded outputs with deterministic checks only; this model scorer was not run.";
export const LOCAL_RUN_SKIP_BASELINE =
  "A local corpus run scores one recorded output per case, for the candidate; there is no recorded baseline output to score.";

const CHECK_KINDS = ["json_schema", "contains", "equals"] as const;

/**
 * A deterministic scorer's config as a check: {kind, config} with a kind the
 * runner knows. Anything else is a reason, recorded as an error on the result
 * rather than guessed at: no output could have passed a check that is not one.
 */
export function checkSpecOf(
  config: unknown,
):
  | { ok: true; spec: { kind: typeof CHECK_KINDS[number]; config: unknown } }
  | { ok: false; reason: string } {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {
      ok: false,
      reason:
        "The scorer config is not a check: it must be an object with a kind and a config.",
    };
  }
  const record = config as Record<string, unknown>;
  if (
    typeof record.kind !== "string" ||
    !(CHECK_KINDS as readonly string[]).includes(record.kind)
  ) {
    return {
      ok: false,
      reason:
        "The scorer config is not a check: kind must be json_schema, contains or equals.",
    };
  }
  return {
    ok: true,
    spec: {
      kind: record.kind as typeof CHECK_KINDS[number],
      config: record.config,
    },
  };
}

/** What a local run does with one missing result. */
export type LocalRunStep =
  | { action: "skip"; reason: string }
  | { action: "check" };

/**
 * A candidate result of a deterministic scorer is checked; everything else is
 * skipped with a reason and stays not attempted: a model scorer needs a
 * provider and the baseline needs an executed output. Required or optional, a
 * check is never replaced by an opinion and a skipped result is never a pass.
 */
export function localRunStep(
  result: Readonly<{ role: Role; evaluatorType: string }>,
): LocalRunStep {
  if (result.role !== "candidate") {
    return { action: "skip", reason: LOCAL_RUN_SKIP_BASELINE };
  }
  if (result.evaluatorType !== "deterministic") {
    return { action: "skip", reason: LOCAL_RUN_SKIP_MODEL };
  }
  return { action: "check" };
}
