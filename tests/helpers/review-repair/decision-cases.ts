import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  CHECK_REASON_RESULTS,
  CHECK_REASONS,
  type CheckReason,
  type CheckResult,
} from "../../../packages/contracts/src/check-evidence.ts";
import {
  DELIVERY_DECISION_REASONS,
  DELIVERY_REASON_DECISIONS,
  type DeliveryDecisionKind,
  type DeliveryDecisionReason,
  isCoherentDeliveryDecision,
  REVIEW_LOOP_LIMITS,
  type ReviewSeverity,
} from "../../../packages/contracts/src/review-evidence.ts";
import {
  REPOSITORY_RULE_MODES,
  type RepositoryRuleMode,
} from "../../../packages/contracts/src/repository-rules.ts";
import {
  type CandidateChecksVerdict,
  type CheckRequirement,
  evaluateCandidateChecks,
  REQUIREMENT_STATUSES,
  type RequirementEvaluation,
  type RequirementStatus,
} from "../../../apps/server/src/modules/delivery/verdict.ts";
import type {
  CandidateIdentity,
  CheckRunEvidence,
} from "../../../apps/server/src/modules/delivery/identity.ts";
import {
  decideDelivery,
  type DecisionCheckFact,
  type DeliveryDecisionInput,
  type DeliveryDecisionResult,
  type PriorDecision,
} from "../../../apps/server/src/modules/delivery/repair-loop.ts";
import {
  currentIdentity,
  digest,
  evidence,
} from "../deterministic-checks/identity-fixture.ts";
import { fingerprintOf } from "./fixtures.ts";

/**
 * Table-driven cases for `decideDelivery`, the pure decision of issue #94. The
 * verdicts are not hand-built: each case records check rows and asks the real
 * #83 evaluator, so the decision is tested against the verdicts production
 * produces. Every row of the design's nine-row table has its own cases, then
 * the ordering between rows, then the input the function must refuse, then an
 * exhaustive grid compared with an independent restatement of the table.
 */

const DAY_MS = REVIEW_LOOP_LIMITS.maxLoopDurationMs;

/** Subject digest the current identity holds for each fixture check id. */
const SUBJECTS: Record<string, string> = {
  unit: digest(3),
  lint: digest(11),
  format: digest(12),
  build: digest(13),
};

/** What a required check did, as the newest recorded row says it. */
type Outcome =
  | "pass"
  | "fail"
  | "signal"
  | "deadline"
  | "output_limit"
  | "tool_missing"
  | "skipped"
  | "canceled"
  | "pending"
  | "stale"
  | "none";

type RowShape = {
  result: CheckResult;
  reason: CheckReason;
  exitCode: number | null;
};

const ROW_SHAPES: Record<Exclude<Outcome, "none" | "stale">, RowShape> = {
  pass: { result: "passed", reason: "verified", exitCode: 0 },
  fail: { result: "failed", reason: "exit_nonzero", exitCode: 1 },
  signal: { result: "failed", reason: "signal", exitCode: null },
  deadline: { result: "failed", reason: "deadline", exitCode: null },
  output_limit: { result: "failed", reason: "output_limit", exitCode: null },
  tool_missing: {
    result: "unavailable",
    reason: "tool_missing",
    exitCode: null,
  },
  skipped: { result: "unavailable", reason: "skipped", exitCode: null },
  canceled: { result: "canceled", reason: "canceled", exitCode: null },
  pending: { result: "pending", reason: "awaiting_result", exitCode: null },
};

type CheckSpec = {
  id: string;
  mode?: RepositoryRuleMode;
  outcome: Outcome;
  /** Records exactly this reason (and the result it belongs to) instead. */
  reason?: CheckReason;
  /** Number of the captured output's digest; null when none was captured. */
  output?: number | null;
};

type PriorSpec = {
  ordinal: number;
  decision?: DeliveryDecisionKind;
  /** Numbers of the fingerprints that blocked that decision's review. */
  fingerprints?: number[];
  /** Failed checks of that decision: check id and output digest number. */
  failed?: Array<[string, number | null]>;
};

type Scenario = {
  checks?: CheckSpec[];
  /** Findings of the review as severity and fingerprint number. */
  findings?: Array<[ReviewSeverity, number]>;
  prior?: PriorSpec[];
  maxRepairCycles?: number;
  maxLoopDurationMs?: number;
  elapsedMs?: number;
  budget?: [remaining: string, next: string] | null;
};

type Built = {
  input: DeliveryDecisionInput;
  /** Row id of each recorded check, by check id. */
  rowIds: Record<string, string>;
  /** Evidence version of each recorded check, by check id. */
  versionIds: Record<string, string>;
};

const DEFAULT_CHECKS: CheckSpec[] = [{ id: "unit", outcome: "pass" }];

function identityFor(): CandidateIdentity {
  const base = currentIdentity();
  return {
    ...base,
    subjects: {
      ...base.subjects,
      ...Object.fromEntries(
        Object.entries(SUBJECTS).map(([id, value]) => [`command:${id}`, value]),
      ),
    },
  };
}

function build(scenario: Scenario = {}): Built {
  const checks = scenario.checks ?? DEFAULT_CHECKS;
  const requirements: CheckRequirement[] = checks.map((check) => ({
    kind: "command",
    checkId: check.id,
    mode: check.mode ?? "require",
  }));
  const rows: CheckRunEvidence[] = [];
  const facts: DecisionCheckFact[] = [];
  const rowIds: Record<string, string> = {};
  const versionIds: Record<string, string> = {};
  checks.forEach((check, index) => {
    if (check.outcome === "none") return;
    const shape: RowShape = check.reason !== undefined
      ? {
        result: CHECK_REASON_RESULTS[check.reason],
        reason: check.reason,
        exitCode: check.reason === "verified"
          ? 0
          : check.reason === "exit_nonzero"
          ? 1
          : null,
      }
      : check.outcome === "stale"
      ? ROW_SHAPES.pass
      : ROW_SHAPES[check.outcome];
    const row = evidence({
      checkId: check.id,
      result: shape.result,
      reason: shape.reason,
      subjectDigest: SUBJECTS[check.id],
      ...(check.outcome === "stale" ? { headSha: "9".repeat(40) } : {}),
    });
    rows.push(row);
    rowIds[check.id] = row.id;
    versionIds[check.id] = crypto.randomUUID();
    facts.push({
      checkRunId: row.id,
      checkId: check.id,
      result: row.result,
      reason: row.reason,
      exitCode: shape.exitCode,
      outputDigest: check.output === null ? null : digest(
        check.output ?? 100 + index,
      ),
      evidenceVersionId: versionIds[check.id],
    });
  });
  const findings = (scenario.findings ?? []).map(([severity, number]) => ({
    fingerprint: fingerprintOf(number),
    severity,
  }));
  const blockingCount =
    findings.filter(({ severity }) =>
      severity === "blocker" || severity === "major"
    ).length;
  const prior: PriorDecision[] = (scenario.prior ?? []).map((entry) => ({
    ordinal: entry.ordinal,
    decision: entry.decision ?? "repair",
    blockingFingerprints: (entry.fingerprints ?? []).map(fingerprintOf),
    failedChecks: (entry.failed ?? []).map(([checkId, output]) => ({
      checkId,
      outputDigest: output === null ? null : digest(output),
    })),
  }));
  const budget = scenario.budget === undefined || scenario.budget === null
    ? null
    : { remainingUsd: scenario.budget[0], nextCycleUsd: scenario.budget[1] };
  return {
    input: {
      verdict: evaluateCandidateChecks({
        requirements,
        rows,
        current: identityFor(),
      }),
      checkFacts: facts,
      review: {
        status: blockingCount === 0 ? "approved" : "changes_requested",
        findings,
      },
      priorDecisions: prior,
      limits: {
        maxRepairCycles: scenario.maxRepairCycles ??
          REVIEW_LOOP_LIMITS.maxRepairCycles,
        maxLoopDurationMs: scenario.maxLoopDurationMs ?? DAY_MS,
      },
      elapsedMs: scenario.elapsedMs ?? 0,
      budget,
    },
    rowIds,
    versionIds,
  };
}

/** What a case expects, in terms a reader can check against the table. */
type Expected = {
  decision: DeliveryDecisionKind;
  reason: DeliveryDecisionReason;
  /** Check ids of `failedChecks`, in order. */
  failed?: string[];
  /** Numbers of `blockingFingerprints`, in review order. */
  blocking?: number[];
  repeated?: { fingerprints?: number[]; checkIds?: string[] };
};

type Case = { name: string; scenario: Scenario; expected: Expected };

function assertOutcome(
  built: Built,
  result: DeliveryDecisionResult,
  expected: Expected,
  name: string,
): void {
  assertEquals(
    [result.decision, result.reason],
    [expected.decision, expected.reason],
    name,
  );
  assertEquals(
    result.failedChecks.map(({ checkId }) => checkId),
    expected.failed ?? [],
    `${name}: failed checks`,
  );
  assertEquals(
    [...result.blockingFingerprints],
    (expected.blocking ?? []).map(fingerprintOf),
    `${name}: blocking fingerprints`,
  );
  assertEquals(
    {
      fingerprints: [...result.repeated.fingerprints],
      checkIds: [...result.repeated.checkIds],
    },
    {
      fingerprints: (expected.repeated?.fingerprints ?? []).map(fingerprintOf),
      checkIds: expected.repeated?.checkIds ?? [],
    },
    `${name}: repeated`,
  );
  // A failed check always carries the facts of its own recorded row.
  for (const failed of result.failedChecks) {
    assertEquals(failed.checkRunId, built.rowIds[failed.checkId], name);
    assertEquals(failed.evidenceVersionId, built.versionIds[failed.checkId]);
    assertEquals(failed.result, "failed");
  }
  assert(
    isCoherentDeliveryDecision(result.decision, result.reason),
    `${name}: the reason belongs to the decision`,
  );
}

function runCases(cases: readonly Case[]): void {
  for (const { name, scenario, expected } of cases) {
    const built = build(scenario);
    assertOutcome(built, decideDelivery(built.input), expected, name);
  }
}

const stop = (
  reason: DeliveryDecisionReason,
  rest: Omit<Expected, "decision" | "reason"> = {},
): Expected => ({ decision: "stop", reason, ...rest });

const policyMissingCases: Case[] = [
  {
    name: "no requirement at all is a missing policy",
    scenario: { checks: [] },
    expected: stop("policy_missing"),
  },
  {
    name:
      "a missing policy outranks blocking findings and every exhausted limit",
    scenario: {
      checks: [],
      findings: [["blocker", 1]],
      prior: [
        { ordinal: 0, fingerprints: [1] },
        { ordinal: 1, fingerprints: [1] },
      ],
      elapsedMs: DAY_MS * 2,
      budget: ["0", "5"],
    },
    expected: stop("policy_missing", { blocking: [1] }),
  },
];

const staleCases: Case[] = [
  {
    name: "a pass recorded against an older head is stale",
    scenario: { checks: [{ id: "unit", outcome: "stale" }] },
    expected: stop("stale_evidence"),
  },
  {
    name: "a required check with no row at all is missing",
    scenario: { checks: [{ id: "unit", outcome: "none" }] },
    expected: stop("stale_evidence"),
  },
  {
    name: "a pending row is missing evidence, never a failure to repair",
    scenario: { checks: [{ id: "unit", outcome: "pending" }] },
    expected: stop("stale_evidence"),
  },
  {
    name: "stale evidence outranks unavailable evidence",
    scenario: {
      checks: [
        { id: "unit", outcome: "tool_missing" },
        { id: "lint", outcome: "stale" },
      ],
    },
    expected: stop("stale_evidence"),
  },
  {
    name: "stale evidence outranks a failed check and a blocking finding",
    scenario: {
      checks: [
        { id: "unit", outcome: "fail" },
        { id: "lint", outcome: "stale" },
      ],
      findings: [["blocker", 1]],
    },
    expected: stop("stale_evidence", { failed: ["unit"], blocking: [1] }),
  },
  {
    name: "one missing required check among passing ones stops the run",
    scenario: {
      checks: [
        { id: "unit", outcome: "pass" },
        { id: "lint", outcome: "none" },
      ],
    },
    expected: stop("stale_evidence"),
  },
];

const unavailableCases: Case[] = [
  {
    name: "a missing tool is unavailable and never repaired",
    scenario: { checks: [{ id: "unit", outcome: "tool_missing" }] },
    expected: stop("checks_unavailable"),
  },
  {
    name: "a canceled check is unavailable and never repaired",
    scenario: { checks: [{ id: "unit", outcome: "canceled" }] },
    expected: stop("checks_unavailable"),
  },
  {
    name: "a skipped check is unavailable and never repaired",
    scenario: { checks: [{ id: "unit", outcome: "skipped" }] },
    expected: stop("checks_unavailable"),
  },
  {
    name: "unavailable evidence outranks a failed check, findings and repeats",
    scenario: {
      checks: [
        { id: "unit", outcome: "fail", output: 7 },
        { id: "lint", outcome: "tool_missing" },
      ],
      findings: [["major", 2]],
      prior: [{ ordinal: 0, fingerprints: [2], failed: [["unit", 7]] }],
      maxRepairCycles: 1,
    },
    expected: stop("checks_unavailable", { failed: ["unit"], blocking: [2] }),
  },
];

const cleanCases: Case[] = [
  {
    name: "AC2 shape: a clean candidate with no history proceeds untouched",
    scenario: {},
    expected: { decision: "proceed", reason: "clean" },
  },
  {
    name: "findings below major alone never block",
    scenario: {
      findings: [["minor", 1], ["note", 2]],
    },
    expected: { decision: "proceed", reason: "clean" },
  },
  {
    name: "a failed warn check and a failed guide check never block",
    scenario: {
      checks: [
        { id: "unit", outcome: "pass" },
        { id: "lint", mode: "warn", outcome: "fail" },
        { id: "format", mode: "guide", outcome: "fail" },
      ],
    },
    expected: { decision: "proceed", reason: "clean" },
  },
  {
    name: "an unavailable or stale warn check never blocks",
    scenario: {
      checks: [
        { id: "unit", outcome: "pass" },
        { id: "lint", mode: "warn", outcome: "tool_missing" },
        { id: "build", mode: "warn", outcome: "stale" },
        { id: "format", mode: "guide", outcome: "none" },
      ],
    },
    expected: { decision: "proceed", reason: "clean" },
  },
  {
    name: "a second cycle that fixed everything proceeds",
    scenario: {
      prior: [{
        ordinal: 0,
        fingerprints: [1],
        failed: [["unit", 100]],
      }],
    },
    expected: { decision: "proceed", reason: "clean" },
  },
  {
    name: "a blocker that is now only a minor finding no longer blocks",
    scenario: {
      findings: [["minor", 1]],
      prior: [{ ordinal: 0, fingerprints: [1] }],
    },
    expected: { decision: "proceed", reason: "clean" },
  },
  {
    name: "a clean candidate proceeds even when every limit is spent",
    scenario: {
      prior: [{ ordinal: 0 }, { ordinal: 1 }],
      elapsedMs: DAY_MS * 3,
      budget: ["0", "9"],
    },
    expected: { decision: "proceed", reason: "clean" },
  },
];

const repeatedCases: Case[] = [
  {
    name:
      "a blocking fingerprint that also blocked the previous decision repeats",
    scenario: {
      findings: [["blocker", 1], ["major", 2]],
      prior: [{ ordinal: 0, fingerprints: [2, 3] }],
    },
    expected: stop("repeated_blocker", {
      blocking: [1, 2],
      repeated: { fingerprints: [2] },
    }),
  },
  {
    name: "a failed check with the same id and output digest repeats",
    scenario: {
      checks: [{ id: "unit", outcome: "fail", output: 55 }],
      prior: [{ ordinal: 0, failed: [["unit", 55]] }],
    },
    expected: stop("repeated_blocker", {
      failed: ["unit"],
      repeated: { checkIds: ["unit"] },
    }),
  },
  {
    name: "a failed check with a different output digest is progress",
    scenario: {
      checks: [{ id: "unit", outcome: "fail", output: 56 }],
      prior: [{ ordinal: 0, failed: [["unit", 55]] }],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["unit"],
    },
  },
  {
    name: "a failed check with no captured output never proves a repeat",
    scenario: {
      checks: [{ id: "unit", outcome: "fail", output: null }],
      prior: [{ ordinal: 0, failed: [["unit", null]] }],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["unit"],
    },
  },
  {
    name: "the same output digest on another check id is not a repeat",
    scenario: {
      checks: [{ id: "unit", outcome: "fail", output: 55 }],
      prior: [{ ordinal: 0, failed: [["lint", 55]] }],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["unit"],
    },
  },
  {
    name: "only the checks whose digest repeated are named as repeated",
    scenario: {
      checks: [
        { id: "unit", outcome: "fail", output: 55 },
        { id: "lint", outcome: "fail", output: 60 },
      ],
      prior: [{ ordinal: 0, failed: [["unit", 55], ["lint", 61]] }],
    },
    expected: stop("repeated_blocker", {
      failed: ["unit", "lint"],
      repeated: { checkIds: ["unit"] },
    }),
  },
  {
    name: "a finding and a check that both repeat are both named",
    scenario: {
      checks: [{ id: "unit", outcome: "fail", output: 55 }],
      findings: [["blocker", 1]],
      prior: [{ ordinal: 0, fingerprints: [1], failed: [["unit", 55]] }],
    },
    expected: stop("repeated_blocker", {
      failed: ["unit"],
      blocking: [1],
      repeated: { fingerprints: [1], checkIds: ["unit"] },
    }),
  },
  {
    name:
      "a blocker from two decisions ago is not the previous cycle's blocker",
    scenario: {
      findings: [["blocker", 1]],
      prior: [
        { ordinal: 0, fingerprints: [1] },
        { ordinal: 1, fingerprints: [2] },
      ],
      maxRepairCycles: 4,
    },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name:
      "the previous decision is the highest ordinal, whatever the order given",
    scenario: {
      findings: [["blocker", 2]],
      prior: [
        { ordinal: 1, fingerprints: [2] },
        { ordinal: 0, fingerprints: [1] },
      ],
      maxRepairCycles: 4,
    },
    expected: stop("repeated_blocker", {
      blocking: [2],
      repeated: { fingerprints: [2] },
    }),
  },
  {
    name: "a repeated blocker outranks spent cycles, time and budget",
    scenario: {
      findings: [["blocker", 1]],
      prior: [
        { ordinal: 0, fingerprints: [9] },
        { ordinal: 1, fingerprints: [1] },
      ],
      elapsedMs: DAY_MS,
      budget: ["0", "5"],
    },
    expected: stop("repeated_blocker", {
      blocking: [1],
      repeated: { fingerprints: [1] },
    }),
  },
  {
    name: "the first review has no previous decision to repeat",
    scenario: { findings: [["blocker", 1]] },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
];

const cycleCases: Case[] = [
  {
    name: "two repairs used with a limit of two stops the loop",
    scenario: {
      findings: [["blocker", 1]],
      prior: [
        { ordinal: 0, fingerprints: [7] },
        { ordinal: 1, fingerprints: [8] },
      ],
    },
    expected: stop("repair_cycles_exhausted", { blocking: [1] }),
  },
  {
    name: "one repair used with a limit of two still repairs",
    scenario: {
      findings: [["blocker", 1]],
      prior: [{ ordinal: 0, fingerprints: [7] }],
    },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "a limit of zero allows no repair at all",
    scenario: {
      checks: [{ id: "unit", outcome: "fail" }],
      maxRepairCycles: 0,
    },
    expected: stop("repair_cycles_exhausted", { failed: ["unit"] }),
  },
  {
    name: "only repair decisions count as repairs used",
    scenario: {
      findings: [["blocker", 1]],
      prior: [
        { ordinal: 0, decision: "stop", fingerprints: [7] },
        { ordinal: 1, decision: "proceed", fingerprints: [8] },
      ],
      maxRepairCycles: 1,
    },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "the ceiling of eight allows the eighth repair and not the ninth",
    scenario: {
      findings: [["blocker", 1]],
      prior: Array.from({ length: 7 }, (_, ordinal) => ({
        ordinal,
        fingerprints: [100 + ordinal],
      })),
      maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling,
    },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "eight repairs used at the ceiling stops the loop",
    scenario: {
      findings: [["blocker", 1]],
      prior: Array.from({ length: 8 }, (_, ordinal) => ({
        ordinal,
        fingerprints: [100 + ordinal],
      })),
      maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling,
    },
    expected: stop("repair_cycles_exhausted", { blocking: [1] }),
  },
  {
    name: "spent cycles outrank spent time and budget",
    scenario: {
      findings: [["blocker", 1]],
      prior: [{ ordinal: 0, fingerprints: [7] }],
      maxRepairCycles: 1,
      elapsedMs: DAY_MS,
      budget: ["0", "5"],
    },
    expected: stop("repair_cycles_exhausted", { blocking: [1] }),
  },
];

const timeCases: Case[] = [
  {
    name: "elapsed time equal to the limit stops the loop",
    scenario: { findings: [["blocker", 1]], elapsedMs: DAY_MS },
    expected: stop("repair_time_exhausted", { blocking: [1] }),
  },
  {
    name: "one millisecond under the limit still repairs",
    scenario: { findings: [["blocker", 1]], elapsedMs: DAY_MS - 1 },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "a short custom limit is honoured",
    scenario: {
      checks: [{ id: "unit", outcome: "fail" }],
      maxLoopDurationMs: 60_000,
      elapsedMs: 60_000,
    },
    expected: stop("repair_time_exhausted", { failed: ["unit"] }),
  },
  {
    name: "spent time outranks a spent budget",
    scenario: {
      findings: [["blocker", 1]],
      elapsedMs: DAY_MS,
      budget: ["0", "5"],
    },
    expected: stop("repair_time_exhausted", { blocking: [1] }),
  },
];

const budgetCases: Case[] = [
  {
    name: "less headroom than the next cycle stops the loop",
    scenario: { findings: [["blocker", 1]], budget: ["4.99", "5.00"] },
    expected: stop("repair_budget_exhausted", { blocking: [1] }),
  },
  {
    name: "headroom equal to the next cycle is enough",
    scenario: { findings: [["blocker", 1]], budget: ["5.00", "5.00"] },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "trailing zeros do not change an amount",
    scenario: { findings: [["blocker", 1]], budget: ["0.10", "0.1"] },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "an amount without a fraction compares like one with zeros",
    scenario: { findings: [["blocker", 1]], budget: ["5", "5.000000"] },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "amounts a float cannot tell apart still differ: one cent short",
    scenario: {
      findings: [["blocker", 1]],
      budget: ["9007199254740992.99", "9007199254740993.00"],
    },
    expected: stop("repair_budget_exhausted", { blocking: [1] }),
  },
  {
    name: "amounts a float cannot tell apart still differ: one cent over",
    scenario: {
      findings: [["blocker", 1]],
      budget: ["9007199254740993.00", "9007199254740992.99"],
    },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "a fraction far below a cent is still compared",
    scenario: {
      findings: [["blocker", 1]],
      budget: ["0.1000000000000000000000000001", "0.1"],
    },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "a fraction far below a cent can also be the shortfall",
    scenario: {
      findings: [["blocker", 1]],
      budget: ["0.1", "0.1000000000000000000000000001"],
    },
    expected: stop("repair_budget_exhausted", { blocking: [1] }),
  },
  {
    name: "an overdrawn budget has no headroom",
    scenario: { findings: [["blocker", 1]], budget: ["-0.01", "0"] },
    expected: stop("repair_budget_exhausted", { blocking: [1] }),
  },
  {
    name: "nothing left is enough when the next cycle costs nothing",
    scenario: { findings: [["blocker", 1]], budget: ["0", "0"] },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "a run without a budget is bounded by cycles and time only",
    scenario: { findings: [["blocker", 1]], budget: null },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
];

const repairCases: Case[] = [
  {
    name: "AC1 shape: an approved review with a failed required check repairs",
    scenario: { checks: [{ id: "unit", outcome: "fail", output: 41 }] },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["unit"],
    },
  },
  {
    name: "a blocking finding with every check passing repairs",
    scenario: { findings: [["blocker", 1]] },
    expected: { decision: "repair", reason: "repair_selected", blocking: [1] },
  },
  {
    name: "a major finding blocks like a blocker",
    scenario: { findings: [["major", 4]] },
    expected: { decision: "repair", reason: "repair_selected", blocking: [4] },
  },
  {
    name: "a failed check and a blocking finding repair together",
    scenario: {
      checks: [{ id: "unit", outcome: "fail" }],
      findings: [["blocker", 1], ["minor", 2]],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["unit"],
      blocking: [1],
    },
  },
  {
    name: "failed checks keep requirement order",
    scenario: {
      checks: [
        { id: "lint", outcome: "fail" },
        { id: "unit", outcome: "fail" },
        { id: "build", outcome: "pass" },
      ],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["lint", "unit"],
    },
  },
  {
    name: "a failed warn check is not handed to the repair",
    scenario: {
      checks: [
        { id: "unit", outcome: "fail" },
        { id: "lint", mode: "warn", outcome: "fail" },
        { id: "format", mode: "guide", outcome: "fail" },
      ],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["unit"],
    },
  },
  {
    name: "blocking fingerprints keep the order the review reported them in",
    scenario: {
      findings: [["major", 3], ["minor", 9], ["blocker", 1]],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      blocking: [3, 1],
    },
  },
  {
    name: "a signal, a deadline and an output limit are failures to repair",
    scenario: {
      checks: [
        { id: "unit", outcome: "signal" },
        { id: "lint", outcome: "deadline" },
        { id: "build", outcome: "output_limit" },
      ],
    },
    expected: {
      decision: "repair",
      reason: "repair_selected",
      failed: ["unit", "lint", "build"],
    },
  },
];

const ALL_CASES = Object.freeze([
  ...policyMissingCases,
  ...staleCases,
  ...unavailableCases,
  ...cleanCases,
  ...repeatedCases,
  ...cycleCases,
  ...timeCases,
  ...budgetCases,
  ...repairCases,
]);

/** Cases that must leave the decision table exactly as the design states it. */
const TABLE_ROWS: ReadonlyArray<
  [row: number, reason: DeliveryDecisionReason, cases: readonly Case[]]
> = [
  [1, "policy_missing", policyMissingCases],
  [2, "stale_evidence", staleCases],
  [3, "checks_unavailable", unavailableCases],
  [4, "clean", cleanCases],
  [5, "repeated_blocker", repeatedCases],
  [6, "repair_cycles_exhausted", cycleCases],
  [7, "repair_time_exhausted", timeCases],
  [8, "repair_budget_exhausted", budgetCases],
  [9, "repair_selected", repairCases],
];

// An independent restatement of the table, written without looking at the
// implementation, used on a grid of combinations.
type GridPoint = {
  outcome: Outcome;
  mode: RepositoryRuleMode;
  finding: "none" | "minor" | "blocker";
  history: "none" | "repeats-finding" | "repeats-check" | "fresh";
  cyclesSpent: boolean;
  timeSpent: boolean;
  budget: "none" | "enough" | "short";
};

function expectedFromGrid(point: GridPoint): {
  decision: DeliveryDecisionKind;
  reason: DeliveryDecisionReason;
} {
  const blocking = point.mode === "require" && point.outcome !== "pass";
  const status = point.outcome;
  if (
    blocking && (status === "stale" || status === "none" ||
      status === "pending")
  ) {
    return { decision: "stop", reason: "stale_evidence" };
  }
  if (
    blocking &&
    (status === "tool_missing" || status === "skipped" || status === "canceled")
  ) return { decision: "stop", reason: "checks_unavailable" };
  const failedBlocking = blocking;
  if (!failedBlocking && point.finding !== "blocker") {
    return { decision: "proceed", reason: "clean" };
  }
  const repeatsFinding = point.history === "repeats-finding" &&
    point.finding === "blocker";
  const repeatsCheck = point.history === "repeats-check" && failedBlocking;
  if (repeatsFinding || repeatsCheck) {
    return { decision: "stop", reason: "repeated_blocker" };
  }
  if (point.cyclesSpent) {
    return { decision: "stop", reason: "repair_cycles_exhausted" };
  }
  if (point.timeSpent) {
    return { decision: "stop", reason: "repair_time_exhausted" };
  }
  if (point.budget === "short") {
    return { decision: "stop", reason: "repair_budget_exhausted" };
  }
  return { decision: "repair", reason: "repair_selected" };
}

function scenarioFromGrid(point: GridPoint): Scenario {
  const prior: PriorSpec[] = [];
  if (point.cyclesSpent) {
    prior.push({ ordinal: 0, fingerprints: [90] }, {
      ordinal: 1,
      fingerprints: point.history === "repeats-finding" ? [1] : [91],
      failed: point.history === "repeats-check" ? [["unit", 200]] : [],
    });
  } else if (point.history !== "none") {
    prior.push({
      ordinal: 0,
      fingerprints: point.history === "repeats-finding" ? [1] : [91],
      failed: point.history === "repeats-check" ? [["unit", 200]] : [],
    });
  }
  return {
    checks: [{
      id: "unit",
      mode: point.mode,
      outcome: point.outcome,
      output: 200,
    }],
    findings: point.finding === "none" ? [] : [
      [point.finding === "blocker" ? "blocker" : "minor", 1],
    ],
    prior,
    elapsedMs: point.timeSpent ? DAY_MS : 0,
    budget: point.budget === "none"
      ? null
      : point.budget === "enough"
      ? ["10.00", "5.00"]
      : ["4.99", "5.00"],
  };
}

function* gridPoints(): Generator<GridPoint> {
  const outcomes: Outcome[] = [
    "pass",
    "fail",
    "signal",
    "tool_missing",
    "skipped",
    "canceled",
    "pending",
    "stale",
    "none",
  ];
  const modes: RepositoryRuleMode[] = ["require", "warn", "guide"];
  const findings = ["none", "minor", "blocker"] as const;
  const histories = [
    "none",
    "repeats-finding",
    "repeats-check",
    "fresh",
  ] as const;
  const budgets = ["none", "enough", "short"] as const;
  for (const outcome of outcomes) {
    for (const mode of modes) {
      for (const finding of findings) {
        for (const history of histories) {
          for (const cyclesSpent of [false, true]) {
            for (const timeSpent of [false, true]) {
              for (const budget of budgets) {
                yield {
                  outcome,
                  mode,
                  finding,
                  history,
                  cyclesSpent,
                  timeSpent,
                  budget,
                };
              }
            }
          }
        }
      }
    }
  }
}

/** Refused input: a mutation of a valid input and the error it must raise. */
type Refusal = {
  name: string;
  scenario?: Scenario;
  mutate: (input: DeliveryDecisionInput) => DeliveryDecisionInput;
  error: string;
};

const asInput = (value: unknown) => value as DeliveryDecisionInput;

/**
 * A verdict rebuilt around evaluations the caller edited. `blocked` and
 * `blockedChecks` follow the edited flags, so the only lie left in the verdict
 * is the one the edit tells.
 */
function verdictWith(
  verdict: CandidateChecksVerdict,
  edit: (
    evaluation: RequirementEvaluation,
    index: number,
  ) => RequirementEvaluation,
): CandidateChecksVerdict {
  const evaluations = verdict.evaluations.map(edit);
  const blockedChecks = evaluations.filter(({ blocking }) => blocking);
  return {
    ...verdict,
    blocked: blockedChecks.length > 0,
    evaluations,
    blockedChecks,
  };
}

/** Refusal that hides a required check by marking evaluation `index` non-blocking. */
const hidesRequiredCheck = (
  name: string,
  scenario: Scenario,
  index = 0,
): Refusal => ({
  name,
  scenario,
  mutate: (i) => ({
    ...i,
    verdict: verdictWith(
      i.verdict,
      (evaluation, at) =>
        at === index ? { ...evaluation, blocking: false } : evaluation,
    ),
  }),
  error: "evaluation_blocking_mismatch",
});

const FAILED: Scenario = { checks: [{ id: "unit", outcome: "fail" }] };
const BLOCKER: Scenario = { findings: [["blocker", 1]] };

const refusals: Refusal[] = [
  {
    name: "an approved review that holds a blocking finding",
    scenario: BLOCKER,
    mutate: (i) => ({ ...i, review: { ...i.review, status: "approved" } }),
    error: "review_status_disagrees_with_findings",
  },
  {
    name: "changes requested with nothing blocking",
    mutate: (i) => ({
      ...i,
      review: { ...i.review, status: "changes_requested" },
    }),
    error: "review_status_disagrees_with_findings",
  },
  {
    name: "an unknown review status",
    mutate: (i) =>
      asInput({ ...i, review: { ...i.review, status: "rejected" } }),
    error: "review_status",
  },
  {
    name: "an upper-case finding fingerprint",
    scenario: BLOCKER,
    mutate: (i) => ({
      ...i,
      review: {
        ...i.review,
        findings: [{
          ...i.review.findings[0],
          fingerprint: fingerprintOf(1).replace("0", "A").replace(/1$/, "F"),
        }],
      },
    }),
    error: "finding_fingerprint",
  },
  {
    name: "a short finding fingerprint",
    scenario: BLOCKER,
    mutate: (i) => ({
      ...i,
      review: {
        ...i.review,
        findings: [{ ...i.review.findings[0], fingerprint: "abc" }],
      },
    }),
    error: "finding_fingerprint",
  },
  {
    name: "an unknown finding severity",
    scenario: BLOCKER,
    mutate: (i) =>
      asInput({
        ...i,
        review: {
          ...i.review,
          findings: [{ ...i.review.findings[0], severity: "critical" }],
        },
      }),
    error: "finding_severity",
  },
  {
    name: "two findings with one fingerprint",
    scenario: { findings: [["blocker", 1], ["minor", 2]] },
    mutate: (i) => ({
      ...i,
      review: {
        ...i.review,
        findings: [i.review.findings[0], {
          ...i.review.findings[1],
          fingerprint: i.review.findings[0].fingerprint,
        }],
      },
    }),
    error: "finding_fingerprint_duplicate",
  },
  {
    name: "a prior decision with an upper-case fingerprint",
    scenario: { prior: [{ ordinal: 0, fingerprints: [1] }] },
    mutate: (i) => ({
      ...i,
      priorDecisions: [{
        ...i.priorDecisions[0],
        blockingFingerprints: ["A".repeat(64)],
      }],
    }),
    error: "prior_fingerprint",
  },
  {
    name: "two prior decisions at one ordinal",
    scenario: { prior: [{ ordinal: 0 }, { ordinal: 1 }] },
    mutate: (i) => ({
      ...i,
      priorDecisions: [i.priorDecisions[0], {
        ...i.priorDecisions[1],
        ordinal: 0,
      }],
    }),
    error: "prior_ordinal",
  },
  {
    name: "a negative prior ordinal",
    scenario: { prior: [{ ordinal: 0 }] },
    mutate: (i) => ({
      ...i,
      priorDecisions: [{ ...i.priorDecisions[0], ordinal: -1 }],
    }),
    error: "prior_ordinal",
  },
  {
    name: "a fractional prior ordinal",
    scenario: { prior: [{ ordinal: 0 }] },
    mutate: (i) => ({
      ...i,
      priorDecisions: [{ ...i.priorDecisions[0], ordinal: 0.5 }],
    }),
    error: "prior_ordinal",
  },
  {
    name: "an unknown prior decision kind",
    scenario: { prior: [{ ordinal: 0 }] },
    mutate: (i) =>
      asInput({
        ...i,
        priorDecisions: [{ ...i.priorDecisions[0], decision: "approve" }],
      }),
    error: "prior_decision",
  },
  {
    name: "a prior failed check with a bad output digest",
    scenario: { prior: [{ ordinal: 0, failed: [["unit", 5]] }] },
    mutate: (i) => ({
      ...i,
      priorDecisions: [{
        ...i.priorDecisions[0],
        failedChecks: [{ checkId: "unit", outputDigest: "not-a-digest" }],
      }],
    }),
    error: "prior_output_digest",
  },
  {
    name: "a prior failed check with no id",
    scenario: { prior: [{ ordinal: 0, failed: [["unit", 5]] }] },
    mutate: (i) => ({
      ...i,
      priorDecisions: [{
        ...i.priorDecisions[0],
        failedChecks: [{ checkId: "", outputDigest: null }],
      }],
    }),
    error: "prior_check_id",
  },
  {
    name: "a negative repair limit",
    mutate: (i) => ({ ...i, limits: { ...i.limits, maxRepairCycles: -1 } }),
    error: "max_repair_cycles",
  },
  {
    name: "a repair limit above the ceiling",
    mutate: (i) => ({
      ...i,
      limits: {
        ...i.limits,
        maxRepairCycles: REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling + 1,
      },
    }),
    error: "max_repair_cycles",
  },
  {
    name: "a fractional repair limit",
    mutate: (i) => ({ ...i, limits: { ...i.limits, maxRepairCycles: 1.5 } }),
    error: "max_repair_cycles",
  },
  {
    name: "a negative time limit",
    mutate: (i) => ({ ...i, limits: { ...i.limits, maxLoopDurationMs: -1 } }),
    error: "max_loop_duration",
  },
  {
    name: "a time limit that is not a number",
    mutate: (i) => ({
      ...i,
      limits: { ...i.limits, maxLoopDurationMs: Number.NaN },
    }),
    error: "max_loop_duration",
  },
  {
    name: "a negative elapsed time",
    mutate: (i) => ({ ...i, elapsedMs: -1 }),
    error: "elapsed_ms",
  },
  {
    name: "an elapsed time that is not a number",
    mutate: (i) => ({ ...i, elapsedMs: Number.NaN }),
    error: "elapsed_ms",
  },
  {
    name: "an infinite elapsed time",
    mutate: (i) => ({ ...i, elapsedMs: Number.POSITIVE_INFINITY }),
    error: "elapsed_ms",
  },
  {
    name: "an elapsed time given as text",
    mutate: (i) => asInput({ ...i, elapsedMs: "5" }),
    error: "elapsed_ms",
  },
  ...["1e3", "", "-", "1.", ".5", "NaN", "0x10", " 1", "1 ", "1,5"].map((
    amount,
  ): Refusal => ({
    name: `a remaining budget written as ${JSON.stringify(amount)}`,
    mutate: (i) => ({
      ...i,
      budget: { remainingUsd: amount, nextCycleUsd: "1.00" },
    }),
    error: "remaining_usd_not_decimal",
  })),
  {
    name: "a remaining budget given as a number",
    mutate: (i) =>
      asInput({ ...i, budget: { remainingUsd: 5, nextCycleUsd: "1.00" } }),
    error: "remaining_usd_not_decimal",
  },
  {
    name: "a next-cycle amount that is not decimal",
    mutate: (i) => ({
      ...i,
      budget: { remainingUsd: "5.00", nextCycleUsd: "1e2" },
    }),
    error: "next_cycle_usd_not_decimal",
  },
  {
    name: "a negative next-cycle amount",
    mutate: (i) => ({
      ...i,
      budget: { remainingUsd: "5.00", nextCycleUsd: "-1.00" },
    }),
    error: "next_cycle_usd_negative",
  },
  {
    name: "an amount with more than thirty digits",
    mutate: (i) => ({
      ...i,
      budget: { remainingUsd: "1".repeat(31), nextCycleUsd: "1.00" },
    }),
    error: "remaining_usd_not_decimal",
  },
  {
    name: "a failed check without the facts of its row",
    scenario: FAILED,
    mutate: (i) => ({ ...i, checkFacts: [] }),
    error: "failed_check_fact_missing",
  },
  {
    name: "a fact whose check id is another check's",
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      checkFacts: [{ ...i.checkFacts[0], checkId: "lint" }],
    }),
    error: "failed_check_fact_disagrees",
  },
  {
    name: "a fact that says the failed row passed",
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      checkFacts: [{
        ...i.checkFacts[0],
        result: "passed",
        reason: "verified",
      }],
    }),
    error: "failed_check_fact_disagrees",
  },
  {
    name: "a fact whose failure reason belongs to another result",
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      checkFacts: [{ ...i.checkFacts[0], reason: "tool_missing" }],
    }),
    error: "failed_check_fact_disagrees",
  },
  {
    name: "a fact with an exit code outside 0 to 255",
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      checkFacts: [{ ...i.checkFacts[0], exitCode: 300 }],
    }),
    error: "failed_check_exit_code",
  },
  {
    name: "a fact with an upper-case output digest",
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      checkFacts: [{ ...i.checkFacts[0], outputDigest: "A".repeat(64) }],
    }),
    error: "failed_check_output_digest",
  },
  {
    name: "two facts for one check run",
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      checkFacts: [i.checkFacts[0], { ...i.checkFacts[0] }],
    }),
    error: "check_fact_duplicate",
  },
  {
    name: "a verdict that says nothing blocks while a requirement does",
    scenario: FAILED,
    mutate: (i) => ({ ...i, verdict: { ...i.verdict, blocked: false } }),
    error: "verdict_blocked_disagrees",
  },
  {
    name: "a verdict that says blocked while nothing blocks",
    mutate: (i) => ({ ...i, verdict: { ...i.verdict, blocked: true } }),
    error: "verdict_blocked_disagrees",
  },
  {
    name: "a blocking evaluation that claims to have passed",
    mutate: (i) => ({
      ...i,
      verdict: {
        ...i.verdict,
        blocked: true,
        evaluations: i.verdict.evaluations.map((evaluation) => ({
          ...evaluation,
          blocking: true,
        })),
      },
    }),
    error: "evaluation_blocking_status",
  },
  hidesRequiredCheck("a required failed check marked non-blocking", FAILED),
  hidesRequiredCheck("a required missing check marked non-blocking", {
    checks: [{ id: "unit", outcome: "none" }],
  }),
  hidesRequiredCheck("a required pending check marked non-blocking", {
    checks: [{ id: "unit", outcome: "pending" }],
  }),
  hidesRequiredCheck("a required unavailable check marked non-blocking", {
    checks: [{ id: "unit", outcome: "tool_missing" }],
  }),
  hidesRequiredCheck("a required canceled check marked non-blocking", {
    checks: [{ id: "unit", outcome: "canceled" }],
  }),
  hidesRequiredCheck("a required stale check marked non-blocking", {
    checks: [{ id: "unit", outcome: "stale" }],
  }),
  hidesRequiredCheck(
    "the second of two required checks, a failed one, marked non-blocking",
    {
      checks: [
        { id: "unit", outcome: "pass" },
        { id: "lint", outcome: "fail" },
      ],
    },
    1,
  ),
  hidesRequiredCheck(
    "a failed required check marked non-blocking while a finding blocks",
    { ...FAILED, findings: [["blocker", 1]] },
  ),
  {
    name: "a warn-only failed check marked blocking",
    scenario: { checks: [{ id: "unit", mode: "warn", outcome: "fail" }] },
    mutate: (i) => ({
      ...i,
      verdict: verdictWith(
        i.verdict,
        (evaluation) => ({ ...evaluation, blocking: true }),
      ),
    }),
    error: "evaluation_blocking_mismatch",
  },
  {
    name: "a warn-only unavailable check marked blocking",
    scenario: {
      checks: [{ id: "unit", mode: "warn", outcome: "tool_missing" }],
    },
    mutate: (i) => ({
      ...i,
      verdict: verdictWith(
        i.verdict,
        (evaluation) => ({ ...evaluation, blocking: true }),
      ),
    }),
    error: "evaluation_blocking_mismatch",
  },
  {
    name: "a guidance-only check marked blocking",
    scenario: { checks: [{ id: "unit", mode: "guide", outcome: "pass" }] },
    mutate: (i) => ({
      ...i,
      verdict: verdictWith(
        i.verdict,
        (evaluation) => ({ ...evaluation, blocking: true }),
      ),
    }),
    error: "evaluation_blocking_status",
  },
  {
    name: "an evaluation whose blocking flag is missing",
    mutate: (i) =>
      asInput({
        ...i,
        verdict: {
          ...i.verdict,
          evaluations: i.verdict.evaluations.map((evaluation) => ({
            ...evaluation,
            blocking: undefined,
          })),
        },
      }),
    error: "evaluation_blocking_mismatch",
  },
  {
    name: "an evaluation whose blocking flag is not a boolean",
    scenario: FAILED,
    mutate: (i) =>
      asInput({
        ...i,
        verdict: {
          ...i.verdict,
          evaluations: i.verdict.evaluations.map((evaluation) => ({
            ...evaluation,
            blocking: 1,
          })),
        },
      }),
    error: "evaluation_blocking_mismatch",
  },
  {
    name: "a failed evaluation that names no row",
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      verdict: {
        ...i.verdict,
        evaluations: i.verdict.evaluations.map((evaluation) => ({
          ...evaluation,
          rowId: null,
        })),
      },
    }),
    error: "failed_check_fact_missing",
  },
  // An unknown mode or status reads as non-blocking in the recomputation
  // below it (`require` is the only blocking mode), so without a closed-set
  // check a flag of `false` would agree with it and a hidden blocker would
  // proceed.
  ...["enforce", "REQUIRE", "Require", "", " require", "blocking"].map((
    mode,
  ): Refusal => ({
    name: `a failed required check whose mode is ${JSON.stringify(mode)}`,
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      verdict: verdictWith(i.verdict, (evaluation) => ({
        ...evaluation,
        requirement: {
          ...evaluation.requirement,
          mode: mode as RepositoryRuleMode,
        },
        blocking: false,
      })),
    }),
    error: "evaluation_mode",
  })),
  ...[undefined, null, 1, true, ["require"]].map((mode): Refusal => ({
    name: `an evaluation whose mode is ${JSON.stringify(mode) ?? "missing"}`,
    scenario: FAILED,
    mutate: (i) =>
      asInput({
        ...i,
        verdict: verdictWith(i.verdict, (evaluation) => ({
          ...evaluation,
          requirement: { ...evaluation.requirement, mode },
          blocking: false,
        } as unknown as RequirementEvaluation)),
      }),
    error: "evaluation_mode",
  })),
  ...["pending", "canceled", "Failed", "PASSED", "ok", "", "fresh"].map((
    status,
  ): Refusal => ({
    name: `a required check whose status is ${JSON.stringify(status)}`,
    scenario: FAILED,
    mutate: (i) => ({
      ...i,
      verdict: verdictWith(i.verdict, (evaluation) => ({
        ...evaluation,
        status: status as RequirementStatus,
        blocking: true,
      })),
    }),
    error: "evaluation_status",
  })),
  ...[undefined, null, 0, false, ["failed"]].map((status): Refusal => ({
    name: `an evaluation whose status is ${
      JSON.stringify(status) ?? "missing"
    }`,
    scenario: FAILED,
    mutate: (i) =>
      asInput({
        ...i,
        verdict: verdictWith(i.verdict, (evaluation) => ({
          ...evaluation,
          status,
          blocking: true,
        } as unknown as RequirementEvaluation)),
      }),
    error: "evaluation_status",
  })),
  {
    name:
      "an unknown status on the second of two evaluations, the first one clean",
    scenario: {
      checks: [
        { id: "unit", outcome: "pass" },
        { id: "lint", outcome: "pass" },
      ],
    },
    mutate: (i) => ({
      ...i,
      verdict: verdictWith(i.verdict, (evaluation, at) =>
        at === 1
          ? {
            ...evaluation,
            status: "pending" as RequirementStatus,
            blocking: true,
          }
          : evaluation),
    }),
    error: "evaluation_status",
  },
];

export function registerDecisionCases(): void {
  Deno.test("the decision table has its nine rows, each with its own cases", () => {
    assertEquals(TABLE_ROWS.map(([row]) => row), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assertEquals(
      TABLE_ROWS.map(([, reason]) => reason),
      [
        "policy_missing",
        "stale_evidence",
        "checks_unavailable",
        "clean",
        "repeated_blocker",
        "repair_cycles_exhausted",
        "repair_time_exhausted",
        "repair_budget_exhausted",
        "repair_selected",
      ],
    );
    // Every reason a decision can take, bar the two that only a failed review
    // job records, is reached by a table row.
    const reachable = new Set(TABLE_ROWS.map(([, reason]) => reason));
    assertEquals(
      DELIVERY_DECISION_REASONS.filter((reason) => !reachable.has(reason)),
      ["reviewer_unavailable", "review_failed"],
    );
    for (const [row, reason, cases] of TABLE_ROWS) {
      assert(cases.length > 0, `row ${row} has cases`);
      assert(
        cases.some((entry) => entry.expected.reason === reason),
        `row ${row} has a case that ends in ${reason}`,
      );
    }
  });

  Deno.test("row 1: no check requirement is a missing policy", () => {
    runCases(policyMissingCases);
    // A verdict that names no evaluation and no reason still fails closed.
    const { input } = build({ checks: [] });
    const silent: CandidateChecksVerdict = {
      blocked: false,
      reason: null,
      evaluations: [],
      blockedChecks: [],
    };
    const result = decideDelivery({ ...input, verdict: silent });
    assertEquals([result.decision, result.reason], [
      "stop",
      "policy_missing",
    ]);
  });

  Deno.test("rows 2 and 3: stale or missing evidence and unavailable evidence stop", () => {
    runCases(staleCases);
    runCases(unavailableCases);
  });

  Deno.test("row 4: nothing blocking and no blocking finding proceeds as clean", () => {
    runCases(cleanCases);
    const { input } = build({});
    const result = decideDelivery(input);
    assertEquals(result.failedChecks, []);
    assertEquals(result.blockingFingerprints, []);
  });

  Deno.test("row 5: a blocker that survived the previous repair stops the loop", () => {
    runCases(repeatedCases);
  });

  Deno.test("rows 6 to 8: spent cycles, time and budget stop, in that order", () => {
    runCases(cycleCases);
    runCases(timeCases);
    runCases(budgetCases);
  });

  Deno.test("row 9: otherwise the candidate is repaired with its failed checks", () => {
    runCases(repairCases);
  });

  Deno.test("AC1: the repair evidence is the failed check run, with its facts", () => {
    const built = build({
      checks: [{ id: "unit", outcome: "fail", output: 41 }],
    });
    const result = decideDelivery(built.input);
    assertEquals([result.decision, result.reason], [
      "repair",
      "repair_selected",
    ]);
    assertEquals(result.failedChecks, [{
      checkRunId: built.rowIds.unit,
      checkId: "unit",
      result: "failed",
      reason: "exit_nonzero",
      exitCode: 1,
      outputDigest: digest(41),
      evidenceVersionId: built.versionIds.unit,
    }]);
    // The review was clean: the repair is driven by the check alone.
    assertEquals(built.input.review.status, "approved");
    assertEquals(result.blockingFingerprints, []);
  });

  Deno.test("AC3: every stop reason is reachable and none of them approves", () => {
    const stops = ALL_CASES.filter(({ expected }) =>
      expected.decision === "stop"
    );
    const reasons = new Set(stops.map(({ expected }) => expected.reason));
    assertEquals(
      [...reasons].sort(),
      [
        "checks_unavailable",
        "policy_missing",
        "repair_budget_exhausted",
        "repair_cycles_exhausted",
        "repair_time_exhausted",
        "repeated_blocker",
        "stale_evidence",
      ],
    );
    for (const { scenario } of stops) {
      const built = build(scenario);
      const result = decideDelivery(built.input);
      assertEquals(result.decision, "stop");
      assert(result.reason !== "clean" && result.reason !== "repair_selected");
    }
  });

  Deno.test("every case ends in a decision that its reason allows", () => {
    for (const { name, scenario } of ALL_CASES) {
      const result = decideDelivery(build(scenario).input);
      assertEquals(
        DELIVERY_REASON_DECISIONS[result.reason],
        result.decision,
        name,
      );
    }
  });

  Deno.test("a repeated blocker names what repeated and nothing else does", () => {
    for (const { name, scenario } of ALL_CASES) {
      const result = decideDelivery(build(scenario).input);
      if (result.reason === "repeated_blocker") {
        assert(
          result.repeated.fingerprints.length +
              result.repeated.checkIds.length >
            0,
          name,
        );
      } else {
        assertEquals(result.repeated.fingerprints, [], name);
        assertEquals(result.repeated.checkIds, [], name);
      }
    }
  });

  Deno.test("only a failed result is ever handed to a repair", () => {
    // Every non-failed outcome of a required check, with a blocking finding
    // that would otherwise justify a repair: none of them repairs.
    const notRepairable: Outcome[] = [
      "tool_missing",
      "skipped",
      "canceled",
      "pending",
      "stale",
      "none",
    ];
    for (const outcome of notRepairable) {
      const built = build({
        checks: [{ id: "unit", outcome }],
        findings: [["blocker", 1]],
      });
      const result = decideDelivery(built.input);
      assertEquals(result.decision, "stop", outcome);
      assertEquals(result.failedChecks, [], outcome);
    }
  });

  Deno.test("every check reason leads to the one decision its result allows", () => {
    for (const reason of CHECK_REASONS) {
      const result = CHECK_REASON_RESULTS[reason];
      const built = build({
        checks: [{ id: "unit", outcome: "pass", reason }],
      });
      const decision = decideDelivery(built.input);
      const expected = result === "passed"
        ? ["proceed", "clean"]
        : result === "failed"
        ? ["repair", "repair_selected"]
        : result === "pending"
        ? ["stop", "stale_evidence"]
        : ["stop", "checks_unavailable"];
      assertEquals([decision.decision, decision.reason], expected, reason);
      assertEquals(
        decision.failedChecks.map((failed) => failed.reason),
        result === "failed" ? [reason] : [],
        reason,
      );
    }
  });

  Deno.test("the decision never proceeds over a blocking requirement or finding", () => {
    let proceeded = 0;
    let points = 0;
    for (const point of gridPoints()) {
      points++;
      const built = build(scenarioFromGrid(point));
      const result = decideDelivery(built.input);
      const expected = expectedFromGrid(point);
      assertEquals(
        [result.decision, result.reason],
        [expected.decision, expected.reason],
        JSON.stringify(point),
      );
      if (result.decision === "proceed") {
        proceeded++;
        assertEquals(result.reason, "clean");
        assertEquals(result.failedChecks, []);
        assertEquals(result.blockingFingerprints, []);
        assert(!built.input.verdict.blocked, JSON.stringify(point));
      }
      if (result.decision === "repair") {
        assert(
          result.failedChecks.length + result.blockingFingerprints.length > 0,
          `a repair has something to repair: ${JSON.stringify(point)}`,
        );
        assert(
          built.input.verdict.blockedChecks.every(({ status }) =>
            status === "failed"
          ),
          `a repair never covers missing evidence: ${JSON.stringify(point)}`,
        );
      }
    }
    assertEquals(points, 9 * 3 * 3 * 4 * 2 * 2 * 3);
    assert(proceeded > 0);
  });

  Deno.test("decimal amounts compare exactly across a sweep of near-equal values", () => {
    const amounts = [
      "0",
      "0.1",
      "0.10",
      "0.2",
      "0.30000000000000004",
      "0.3",
      "9007199254740991",
      "9007199254740992",
      "9007199254740993",
      "9007199254740992.5",
      "100.00",
      "99.999999999999999999",
    ];
    // Reference: compare through BigInt after scaling to 20 digits.
    const scaled = (amount: string): bigint => {
      const [whole, fraction = ""] = amount.split(".");
      return BigInt(whole + fraction.padEnd(20, "0"));
    };
    for (const remaining of amounts) {
      for (const next of amounts) {
        const built = build({
          findings: [["blocker", 1]],
          budget: [remaining, next],
        });
        const result = decideDelivery(built.input);
        const short = scaled(remaining) < scaled(next);
        assertEquals(
          result.reason,
          short ? "repair_budget_exhausted" : "repair_selected",
          `${remaining} against ${next}`,
        );
      }
    }
  });

  Deno.test("the decision refuses input the types do not allow", () => {
    for (const refusal of refusals) {
      const { input } = build(refusal.scenario ?? {});
      const bad = refusal.mutate(input);
      assertThrows(
        () => decideDelivery(bad),
        Error,
        `DELIVERY_DECISION_INPUT_INVALID:${refusal.error}`,
        refusal.name,
      );
    }
  });

  Deno.test("the blocking flag of every evaluation is recomputed from its mode and status", () => {
    // Every mode against every status with either flag, in a verdict whose
    // `blocked` and `blockedChecks` agree with the flag. A flag that differs
    // from "require and not passed" is refused; a hidden blocker never
    // reaches a decision, so it can never be `proceed`.
    const modes: RepositoryRuleMode[] = ["require", "warn", "guide"];
    const statuses: RequirementStatus[] = [
      "passed",
      "failed",
      "unavailable",
      "stale",
      "missing",
      "not_blocking",
    ];
    let refused = 0;
    for (const mode of modes) {
      for (const status of statuses) {
        for (const claimed of [false, true]) {
          const name = `${mode} + ${status} claimed ${
            claimed ? "blocking" : "non-blocking"
          }`;
          const { input } = build({
            checks: [{ id: "unit", mode, outcome: "pass" }],
          });
          const verdict = verdictWith(input.verdict, (evaluation) => ({
            ...evaluation,
            status,
            blocking: claimed,
          }));
          const correct = mode === "require" && status !== "passed";
          // A blocking claim over a passed or guidance-only status is also
          // refused by the older status rule, whatever the mode says.
          const incoherent = claimed &&
            (status === "passed" || status === "not_blocking");
          let outcome: DeliveryDecisionResult | Error;
          try {
            outcome = decideDelivery({ ...input, verdict });
          } catch (error) {
            assert(error instanceof Error, name);
            outcome = error;
          }
          if (claimed !== correct || incoherent) {
            refused++;
            assert(outcome instanceof Error, `${name}: must be refused`);
            assert(
              /^DELIVERY_DECISION_INPUT_INVALID:evaluation_blocking_(mismatch|status)$/
                .test(outcome.message),
              `${name}: ${outcome.message}`,
            );
          } else if (outcome instanceof Error) {
            assert(
              !outcome.message.includes("evaluation_blocking"),
              `${name}: ${outcome.message}`,
            );
          } else if (correct) {
            assert(outcome.decision !== "proceed", `${name}: proceeds`);
          }
        }
      }
    }
    // Of the 36 combinations, 18 lie about the flag; a require evaluation that
    // is `not_blocking` and claims to block is the 19th the status rule refuses.
    assertEquals(refused, 19);
  });

  Deno.test("every known mode and status is accepted and the sets are exactly those", () => {
    assertEquals([...REPOSITORY_RULE_MODES], ["guide", "warn", "require"]);
    assertEquals([...REQUIREMENT_STATUSES], [
      "passed",
      "failed",
      "unavailable",
      "stale",
      "missing",
      "not_blocking",
    ]);
    // The only refusals the 36-combination grid above produces are the
    // blocking-flag ones, so a known mode and status never trips the closed sets.
    for (const mode of REPOSITORY_RULE_MODES) {
      for (const status of REQUIREMENT_STATUSES) {
        const { input } = build({
          checks: [{ id: "unit", mode, outcome: "pass" }],
        });
        const verdict = verdictWith(input.verdict, (evaluation) => ({
          ...evaluation,
          status,
          blocking: mode === "require" && status !== "passed",
        }));
        try {
          decideDelivery({ ...input, verdict });
        } catch (error) {
          assert(error instanceof Error);
          assert(
            !/evaluation_(mode|status)$/.test(error.message),
            `${mode}/${status}: ${error.message}`,
          );
        }
      }
    }
  });

  Deno.test("a hand-built verdict that hides a failed required check never proceeds", () => {
    const { input } = build(FAILED);
    const hidden = verdictWith(
      input.verdict,
      (evaluation) => ({ ...evaluation, blocking: false }),
    );
    assertEquals(hidden.blocked, false);
    assertThrows(
      () => decideDelivery({ ...input, verdict: hidden }),
      Error,
      "DELIVERY_DECISION_INPUT_INVALID:evaluation_blocking_mismatch",
    );
    // The same verdict as the real evaluator builds it still repairs.
    const honest = decideDelivery(input);
    assertEquals([honest.decision, honest.reason], [
      "repair",
      "repair_selected",
    ]);
    assertEquals(honest.failedChecks.map(({ checkId }) => checkId), ["unit"]);
  });

  Deno.test("an evaluation list with a hole or a non-object entry is refused, never proceeded", () => {
    const { input } = build(FAILED);
    const [failed] = input.verdict.evaluations;
    const asVerdict = (
      evaluations: unknown,
      blocked = false,
    ) => ({
      ...input.verdict,
      blocked,
      evaluations,
      blockedChecks: [],
    } as unknown as CandidateChecksVerdict);
    const sparse = new Array<RequirementEvaluation>(1);
    const middleHole = [failed, , failed] as RequirementEvaluation[];
    assertEquals(0 in sparse, false);
    assertEquals(1 in middleHole, false);
    const cases: Array<[string, unknown, string]> = [
      ["a one-slot sparse array", sparse, "evaluation_entry"],
      ["a hole between two evaluations", middleHole, "evaluation_entry"],
      ["an undefined entry", [undefined], "evaluation_entry"],
      ["a null entry", [null], "evaluation_entry"],
      ["a number entry", [1], "evaluation_entry"],
      ["a string entry", ["unit"], "evaluation_entry"],
      [
        "an entry without a requirement",
        [{ ...failed, requirement: null }],
        "evaluation_requirement",
      ],
      ["an entry whose requirement is a string", [{
        ...failed,
        requirement: "unit",
      }], "evaluation_requirement"],
      ["an array-like object", { length: 1, 0: failed }, "evaluations"],
      ["a null list", null, "evaluations"],
      ["a string list", "unit", "evaluations"],
    ];
    for (const [name, evaluations, error] of cases) {
      // `blocked: false` is what a verdict that skipped the hole would say.
      for (const blocked of [false, true]) {
        assertThrows(
          () =>
            decideDelivery({
              ...input,
              verdict: asVerdict(evaluations, blocked),
            }),
          Error,
          `DELIVERY_DECISION_INPUT_INVALID:${error}`,
          `${name} (blocked ${blocked})`,
        );
      }
    }
    // The same verdict with a dense list is still decided, and repaired.
    const honest = decideDelivery(input);
    assertEquals([honest.decision, honest.reason], [
      "repair",
      "repair_selected",
    ]);
  });

  Deno.test("each field of the verdict is read once, so a getter cannot change the answer between validation and use", () => {
    const { input } = build(FAILED);
    const honest = decideDelivery(input);
    const [failed] = input.verdict.evaluations;
    /** A property that answers `values[n]` on its nth read and counts reads. */
    const counted = <T extends object>(
      target: T,
      key: string,
      values: readonly unknown[],
    ) => {
      let reads = 0;
      Object.defineProperty(target, key, {
        enumerable: true,
        configurable: true,
        get: () => values[Math.min(reads++, values.length - 1)],
      });
      return () => reads;
    };
    const decide = (verdict: CandidateChecksVerdict) =>
      decideDelivery({ ...input, verdict });
    const withEvaluations = (evaluations: RequirementEvaluation[]) => ({
      ...input.verdict,
      evaluations,
    });

    // The mode answers `require` first and `warn` after: the decision is the
    // one the first answer gives, and the getter is read exactly once.
    const requirement = { ...failed.requirement };
    const modeReads = counted(requirement, "mode", ["require", "warn"]);
    assertEquals(decide(withEvaluations([{ ...failed, requirement }])), honest);
    assertEquals(modeReads(), 1);

    // The status answers `failed` first and `passed` after.
    const withStatus = { ...failed };
    const statusReads = counted(withStatus, "status", ["failed", "passed"]);
    assertEquals(decide(withEvaluations([withStatus])), honest);
    assertEquals(statusReads(), 1);

    // The blocking flag answers `true` first and `false` after.
    const withFlag = { ...failed };
    const flagReads = counted(withFlag, "blocking", [true, false]);
    assertEquals(decide(withEvaluations([withFlag])), honest);
    assertEquals(flagReads(), 1);

    // The requirement itself is a getter that hands out a different object.
    const swapped = { ...failed };
    const requirementReads = counted(swapped, "requirement", [
      failed.requirement,
      { ...failed.requirement, mode: "guide" },
    ]);
    assertEquals(decide(withEvaluations([swapped])), honest);
    assertEquals(requirementReads(), 1);

    // An index of the list is an accessor that answers a different evaluation
    // on its second read.
    const list = [failed];
    const entryReads = counted(list, "0", [
      failed,
      { ...failed, status: "passed", blocking: false },
    ]);
    assertEquals(decide(withEvaluations(list)), honest);
    assertEquals(entryReads(), 1);

    // The verdict hands out a blocking list first and an empty one after.
    const verdict = { ...input.verdict };
    const listReads = counted(verdict, "evaluations", [
      input.verdict.evaluations,
      [],
    ]);
    assertEquals(decide(verdict), honest);
    assertEquals(listReads(), 1);

    // The verdict's `blocked` flag answers `true` first and `false` after.
    const flagged = { ...input.verdict };
    const blockedReads = counted(flagged, "blocked", [true, false]);
    assertEquals(decide(flagged), honest);
    assertEquals(blockedReads(), 1);
  });

  Deno.test("the decision is pure: the same input gives the same answer and is not changed", () => {
    for (const { scenario } of ALL_CASES) {
      const { input } = build(scenario);
      const before = structuredClone(input);
      const first = decideDelivery(input);
      const second = decideDelivery(input);
      assertEquals(second, first);
      assertEquals(input, before);
    }
  });

  Deno.test("prior decisions in any order give the same answer", () => {
    const prior: PriorDecision[] = build({
      prior: [
        { ordinal: 0, fingerprints: [1] },
        { ordinal: 1, fingerprints: [2] },
        { ordinal: 2, fingerprints: [3] },
      ],
      findings: [["blocker", 3]],
      maxRepairCycles: 8,
    }).input.priorDecisions as PriorDecision[];
    const { input } = build({ findings: [["blocker", 3]], maxRepairCycles: 8 });
    const orders = [[0, 1, 2], [2, 1, 0], [1, 2, 0], [2, 0, 1]];
    const answers = orders.map((order) =>
      decideDelivery({
        ...input,
        priorDecisions: order.map((index) => prior[index]),
      })
    );
    for (const answer of answers) {
      assertEquals(answer.reason, "repeated_blocker");
      assertEquals(answer, answers[0]);
    }
  });
}
