import {
  CHECK_REASONS,
  CHECK_RESULTS,
  type CheckReason,
  type CheckResult,
} from "../../../packages/contracts/src/check-evidence.ts";
import {
  isBlockingSeverity,
  REVIEW_FINDING_DETAIL_MAX_LENGTH,
  REVIEW_FINDING_PATH_MAX_LENGTH,
  REVIEW_LOOP_LIMITS,
  type ReviewSeverity,
} from "../../../packages/contracts/src/review-evidence.ts";
import transportSchemas from "../../../packages/contracts/generated/transport-schemas.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  SHA256_C,
} from "../deterministic-checks/observations.ts";

/**
 * Shared builders for review and repair tests. Every lane imports the same
 * helpers, so a finding or a review report means the same thing in each.
 */

type JsonRecord = Record<string, unknown>;
type InputField = {
  name: string;
  type: string;
  required?: boolean;
  bounds?: Record<string, number>;
  description?: string;
};

/**
 * Bytes a step's own job input may use once the pinned profile and rules are
 * counted. `EXECUTION_JOB_INPUT_BYTES_MAX` is 100,000 and the organization
 * rules plus the profile leave at least this much even for the worst pin
 * (packages/contracts/src/repository-rules.ts:664-686).
 */
export const JOB_INPUT_STEP_MARGIN_BYTES = 30_000;

/** Largest line a finding may carry: the int4 `review_findings.line` column. */
export const FINDING_LINE_MAX = 2_147_483_647;

/** The wire shape of one finding in a review report or a repair input. */
export type FindingFixture = {
  fingerprint: string;
  severity: ReviewSeverity;
  blocking: boolean;
  path: string;
  line: number | null;
  detail: string;
};

/** A distinct, well-formed 64-hex fingerprint for the n-th finding. */
export function fingerprintOf(n: number): string {
  return n.toString(16).padStart(64, "0");
}

/** A finding whose `blocking` flag agrees with its severity. */
export function finding(
  overrides: Partial<FindingFixture> = {},
): FindingFixture {
  const severity = overrides.severity ?? "major";
  return {
    fingerprint: fingerprintOf(1),
    severity,
    blocking: isBlockingSeverity(severity),
    path: "src/service.ts",
    line: 42,
    detail: "The retry loop never stops when the provider keeps failing.",
    ...overrides,
  };
}

/**
 * A finding with every free-text field filled to its contract maximum.
 * `unit` is the filler character, so a multi-byte unit shows how much a
 * character-bounded field can grow in UTF-8 bytes.
 */
export function worstCaseFinding(
  index: number,
  unit = "x",
  severity: ReviewSeverity = "blocker",
): FindingFixture {
  return finding({
    fingerprint: fingerprintOf(index + 1),
    severity,
    path: unit.repeat(REVIEW_FINDING_PATH_MAX_LENGTH),
    line: FINDING_LINE_MAX,
    detail: unit.repeat(REVIEW_FINDING_DETAIL_MAX_LENGTH),
  });
}

/** A complete `ReviewOutput` around the given findings. */
export function reviewOutput(
  findings: readonly FindingFixture[],
  overrides: Record<string, unknown> = {},
) {
  return {
    reviewId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    policyDigest: SHA256_C,
    findings: [...findings],
    blockingFindings: findings.filter(({ blocking }) => blocking).length,
    ...overrides,
  };
}

/** A `ReviewOutput` carrying the most findings the contract allows. */
export function worstCaseReviewOutput(unit = "x") {
  return reviewOutput(
    Array.from(
      { length: REVIEW_LOOP_LIMITS.maxFindings },
      (_, index) => worstCaseFinding(index, unit),
    ),
  );
}

/** The wire shape of one failed check handed to a repair step. */
export type FailedCheckFixture = {
  checkRunId: string;
  checkId: string;
  result: Exclude<CheckResult, "passed">;
  reason: Exclude<CheckReason, "verified">;
  exitCode: number | null;
};

export function failedCheck(
  overrides: Partial<FailedCheckFixture> = {},
): FailedCheckFixture {
  return {
    checkRunId: crypto.randomUUID(),
    checkId: "unit",
    result: "failed",
    reason: "exit_nonzero",
    exitCode: 1,
    ...overrides,
  };
}

/** A failed check with every field at its contract maximum. */
export function worstCaseFailedCheck(): FailedCheckFixture {
  const inputs = (transportSchemas as unknown as {
    inputs: Record<string, { fields: InputField[] }>;
  }).inputs;
  const bounds = inputs.FailedCheck.fields.find(({ name }) =>
    name === "checkId"
  )?.bounds;
  const reasons = CHECK_REASONS.filter((reason) => reason !== "verified");
  const results = CHECK_RESULTS.filter((result) => result !== "passed");
  const longest = <T extends string>(values: readonly T[]): T =>
    values.reduce((a, b) => b.length > a.length ? b : a);
  return failedCheck({
    checkId: "x".repeat(bounds?.maxLength ?? 0),
    result: longest(results),
    reason: longest(reasons),
    exitCode: 255,
  });
}

/** A complete `RepairInput`; the revision is a full 40-hex commit id. */
export function repairInput(
  parts: {
    findings?: readonly FindingFixture[];
    failedChecks?: readonly FailedCheckFixture[];
  } = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    repositoryId: crypto.randomUUID(),
    revision: HEAD_SHA,
    findings: [...(parts.findings ?? [finding()])],
    failedChecks: [...(parts.failedChecks ?? [])],
    ...overrides,
  };
}

/** `inputs.<name>` of the shipped transport schemas. */
export function transportInput(
  name: string,
): { fields: InputField[]; description: string } {
  const inputs = (transportSchemas as unknown as { inputs: JsonRecord })
    .inputs;
  const definition = inputs[name];
  if (!definition || typeof definition !== "object") {
    throw new Error(`TRANSPORT_INPUT_MISSING:${name}`);
  }
  return definition as { fields: InputField[]; description: string };
}

/** One field of a transport input by name. */
export function inputField(inputName: string, field: string): InputField {
  const found = transportInput(inputName).fields.find(({ name }) =>
    name === field
  );
  if (!found) throw new Error(`TRANSPORT_FIELD_MISSING:${inputName}.${field}`);
  return found;
}

/** A normalized flat workflow spec made of the given actions, in order. */
export function loopSpec(
  steps: ReadonlyArray<string | { uses: string; if?: string }>,
): { kind: "fixed"; workflow: { kind: "fixed" }; steps: unknown[] } {
  return {
    kind: "fixed",
    workflow: { kind: "fixed" },
    steps: steps.map((step, index) => {
      const entry = typeof step === "string" ? { uses: step } : step;
      return { id: `step${index}`, with: {}, ...entry };
    }),
  };
}

/** The shape of the reviewed preset: brief, implement, repair, check, review. */
export const REVIEW_LOOP_ACTIONS = Object.freeze(
  [
    "task.brief",
    "harness.implement",
    "harness.repair",
    "quality.check",
    "review.independent",
  ] as const,
);
