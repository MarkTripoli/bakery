import { REPOSITORY_FIXED_POLICY_ACTION_EFFECTS } from "./repository-profile-config.ts";
import { CHECK_OBSERVATION_MAX_ITEMS } from "./check-evidence.ts";
import { canonicalJson, sha256Hex } from "./workflow-compiler/canonical.ts";

/**
 * Vocabulary, limits and pure rules for independent review and bounded repair
 * (issue #94). The worker that reviews a candidate, the server that verifies
 * the report and the workflow admission code all import this module, so none
 * of them can drift from the others.
 */

/** How serious a review finding is. Only blocker and major block delivery. */
export const REVIEW_SEVERITIES = Object.freeze(
  ["blocker", "major", "minor", "note"] as const,
);
export type ReviewSeverity = typeof REVIEW_SEVERITIES[number];

export function isReviewSeverity(value: unknown): value is ReviewSeverity {
  return typeof value === "string" &&
    (REVIEW_SEVERITIES as readonly string[]).includes(value);
}

/**
 * True for the severities that block delivery. A finding's `blocking` flag is
 * redundant with its severity, and the server rejects a report where they
 * disagree, so a reviewer cannot hide a blocker behind `blocking: false`.
 */
export function isBlockingSeverity(severity: ReviewSeverity): boolean {
  return severity === "blocker" || severity === "major";
}

/** What a delivery decision tells the run to do next. */
export const DELIVERY_DECISIONS = Object.freeze(
  ["proceed", "repair", "stop"] as const,
);
export type DeliveryDecisionKind = typeof DELIVERY_DECISIONS[number];

export function isDeliveryDecision(
  value: unknown,
): value is DeliveryDecisionKind {
  return typeof value === "string" &&
    (DELIVERY_DECISIONS as readonly string[]).includes(value);
}

/**
 * Why a decision was taken. `clean` and `repair_selected` are the only
 * non-stop reasons; every other reason ends the run with a durable record.
 */
export const DELIVERY_DECISION_REASONS = Object.freeze(
  [
    "clean",
    "repair_selected",
    "policy_missing",
    "stale_evidence",
    "checks_unavailable",
    "repeated_blocker",
    "repair_cycles_exhausted",
    "repair_time_exhausted",
    "repair_budget_exhausted",
    "reviewer_unavailable",
    "review_failed",
  ] as const,
);
export type DeliveryDecisionReason = typeof DELIVERY_DECISION_REASONS[number];

export function isDeliveryDecisionReason(
  value: unknown,
): value is DeliveryDecisionReason {
  return typeof value === "string" &&
    (DELIVERY_DECISION_REASONS as readonly string[]).includes(value);
}

/**
 * The one decision each reason may accompany: `clean` proceeds,
 * `repair_selected` repairs and every other reason stops the run.
 */
export const DELIVERY_REASON_DECISIONS: Readonly<
  Record<DeliveryDecisionReason, DeliveryDecisionKind>
> = Object.freeze({
  clean: "proceed",
  repair_selected: "repair",
  policy_missing: "stop",
  stale_evidence: "stop",
  checks_unavailable: "stop",
  repeated_blocker: "stop",
  repair_cycles_exhausted: "stop",
  repair_time_exhausted: "stop",
  repair_budget_exhausted: "stop",
  reviewer_unavailable: "stop",
  review_failed: "stop",
});

/** True when `reason` is a legal explanation for `decision`. */
export function isCoherentDeliveryDecision(
  decision: DeliveryDecisionKind,
  reason: DeliveryDecisionReason,
): boolean {
  return DELIVERY_REASON_DECISIONS[reason] === decision;
}

/** Error code of the pre-failed gate step that records a stopped loop. */
export const DELIVERY_LOOP_STOPPED_CODE = "DELIVERY_LOOP_STOPPED";

/** Step key of the pre-failed gate step inserted when a loop stops. */
export const DELIVERY_GATE_STEP_KEY = "delivery_gate";

/**
 * Bounds of the review and repair loop. The counts and durations are frozen
 * into a run's snapshot at admission; a workflow may lower
 * `maxRepairCycles` but never raise it above the ceiling. `maxFindings` and
 * `resultByteBudget` bound one review report: the budget is the serialized
 * bytes the server accepts, small enough that the blocking findings of one
 * review plus the failed checks still fit the repair step's job input.
 */
export const REVIEW_LOOP_LIMITS = Object.freeze({
  maxRepairCycles: 2,
  maxRepairCyclesCeiling: 8,
  maxLoopDurationMs: 24 * 60 * 60 * 1000,
  maxFindings: 25,
  resultByteBudget: 20_000,
});

/** Longest finding path, in characters. */
export const REVIEW_FINDING_PATH_MAX_LENGTH = 200;

/** Longest finding detail, in characters. */
export const REVIEW_FINDING_DETAIL_MAX_LENGTH = 500;

/** Most failed checks one repair input carries: one per fixed check. */
export const REPAIR_FAILED_CHECKS_MAX_ITEMS = CHECK_OBSERVATION_MAX_ITEMS;

/** Most check runs one review input names as evidence. */
export const REVIEW_EVIDENCE_MAX_ITEMS = CHECK_OBSERVATION_MAX_ITEMS;

/**
 * UTF-8 bytes of the canonical JSON of `value`. Workers and the server measure
 * a report this way, so the budget is the same number on both sides.
 */
export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

/** What identifies a finding independent of where in the file it sits. */
export type FindingKey = {
  readonly path: string;
  readonly category: string;
  readonly title: string;
};

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The normalized form a fingerprint is computed from: lowercase, whitespace
 * collapsed and trimmed, and no line numbers. A trailing `:line` or
 * `:line:column` on the path is dropped, so a finding that only moved inside
 * its file keeps its fingerprint.
 */
export function normalizeFindingKey(key: FindingKey): FindingKey {
  return {
    path: normalizeText(key.path).replace(/(?::\d+){1,2}$/, ""),
    category: normalizeText(key.category),
    title: normalizeText(key.title),
  };
}

/**
 * Lowercase SHA-256 hex over the canonical JSON of the normalized key. The
 * same finding reported again after a repair gets the same fingerprint, which
 * is how the loop recognizes a blocker that survived a repair.
 */
export function findingFingerprint(key: FindingKey): Promise<string> {
  return sha256Hex(canonicalJson(normalizeFindingKey(key)));
}

const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = Object.freeze({
  blocker: 0,
  major: 1,
  minor: 2,
  note: 3,
});

/** What the budget rule needs to read and shorten on one finding. */
export type TrimmableFinding = {
  readonly severity: ReviewSeverity;
  readonly detail: string;
};

/** Detail lengths, in code points, the budget rule shortens a finding to. */
const NON_BLOCKING_DETAIL_CAP = 120;
const BLOCKING_DETAIL_CAPS = Object.freeze([250, 120, 40]);

function truncated<F extends TrimmableFinding>(finding: F, cap: number): F {
  const points = Array.from(finding.detail);
  return points.length <= cap
    ? finding
    : { ...finding, detail: points.slice(0, cap).join("") };
}

/**
 * Fits findings into a byte budget the way a reviewer worker does before it
 * reports. Findings are ordered blocker first. The rule never drops a
 * blocking finding: it shortens the details of non-blocking findings, then
 * drops non-blocking findings from the least severe end, and only then
 * shortens the details of blocking ones. `fits` says whether a candidate list
 * is within the budget once placed in its report. Returns `null` when even
 * shortened blocking findings do not fit, so the worker faults instead of
 * hiding a blocker.
 */
export function fitFindingsToBudget<F extends TrimmableFinding>(
  findings: readonly F[],
  fits: (candidate: readonly F[]) => boolean,
): F[] | null {
  const ordered = findings
    .map((finding, index) => ({ finding, index }))
    .sort((a, b) =>
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
      a.index - b.index
    )
    .map(({ finding }) => finding);
  if (fits(ordered)) return ordered;
  const blocking = (finding: F) => isBlockingSeverity(finding.severity);
  let current = ordered.map((finding) =>
    blocking(finding) ? finding : truncated(finding, NON_BLOCKING_DETAIL_CAP)
  );
  if (fits(current)) return current;
  while (current.length > 0 && !blocking(current[current.length - 1])) {
    current = current.slice(0, -1);
    if (fits(current)) return current;
  }
  for (const cap of BLOCKING_DETAIL_CAPS) {
    current = current.map((finding) => truncated(finding, cap));
    if (fits(current)) return current;
  }
  return null;
}

/** The slice of a normalized workflow step the loop-shape rule reads. */
type LoopSpecStep = {
  readonly uses: string;
  readonly conditional: boolean;
};

function loopSpecSteps(spec: unknown): readonly LoopSpecStep[] | null {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    return null;
  }
  const steps: unknown = Reflect.get(spec, "steps");
  if (!Array.isArray(steps)) return null;
  const result: LoopSpecStep[] = [];
  for (const step of steps) {
    if (typeof step !== "object" || step === null || Array.isArray(step)) {
      return null;
    }
    const uses: unknown = Reflect.get(step, "uses");
    if (typeof uses !== "string") return null;
    result.push({
      uses,
      conditional: Reflect.get(step, "if") !== undefined,
    });
  }
  return result;
}

/**
 * True when a normalized fixed-workflow spec has the shape the review and
 * repair loop acts on: exactly one unconditional `harness.repair`,
 * `quality.check` and `review.independent` step, in that order, with a
 * revision-producing step (`harness.implement`) before the repair, and the
 * review as the last step. A repair iteration is appended after every existing
 * step, so a step that followed the review would run on the unrepaired
 * candidate before the repair. Any other shape gets no loop, so a workflow that
 * merely mentions these actions is never rewritten. The workflow extractor, the
 * snapshot builder and the review finalizer all use this one definition.
 */
export function isReviewLoopSpec(spec: unknown): boolean {
  const steps = loopSpecSteps(spec);
  if (steps === null) return false;
  const indexesOf = (action: string): number[] =>
    steps.flatMap((step, index) => step.uses === action ? [index] : []);
  const [repair, check, review] = [
    indexesOf("harness.repair"),
    indexesOf("quality.check"),
    indexesOf("review.independent"),
  ];
  if (repair.length !== 1 || check.length !== 1 || review.length !== 1) {
    return false;
  }
  if (
    steps[repair[0]].conditional || steps[check[0]].conditional ||
    steps[review[0]].conditional
  ) return false;
  if (!(repair[0] < check[0] && check[0] < review[0])) return false;
  if (review[0] !== steps.length - 1) return false;
  return steps.slice(0, repair[0]).some((step) =>
    (REPOSITORY_FIXED_POLICY_ACTION_EFFECTS as Readonly<
      Record<string, string | undefined>
    >)[step.uses] === "repository_revision"
  );
}
