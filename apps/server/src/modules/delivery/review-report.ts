import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import {
  isBlockingSeverity,
  REVIEW_FINDING_DETAIL_MAX_LENGTH,
  REVIEW_FINDING_PATH_MAX_LENGTH,
  REVIEW_SEVERITIES,
  serializedBytes,
} from "@bakery/contracts/review-evidence";
import { nullable } from "./identity.ts";
import type { ReviewPins } from "./review-pins.ts";

/**
 * The worker's `review.independent` report as the server reads it, and the
 * rules a report must satisfy before any row is written. The registry already
 * parsed the wire shape; this parse gives typed access and fails closed if the
 * two ever disagree. Nothing in a report is an identity or an approval the
 * server believes: the server derives the head, base and policy from the job's
 * own pins, recomputes the blocking count from the findings, and only compares.
 */

/** `VALIDATION_FAILED` reason: the report contradicts what the server derived. */
export const REVIEW_REPORT_INVALID_REASON = "review_report_invalid";

/** Which rule a refused report broke; carried as `params.subReason`. */
export const REVIEW_REPORT_SUB_REASONS = Object.freeze(
  [
    "shape",
    "head_mismatch",
    "base_mismatch",
    "policy_mismatch",
    "findings_over_limit",
    "fingerprint_invalid",
    "fingerprint_duplicate",
    "path_invalid",
    "detail_invalid",
    "line_invalid",
    "blocking_flag_mismatch",
    "blocking_count_mismatch",
    "over_budget",
  ] as const,
);
export type ReviewReportSubReason = typeof REVIEW_REPORT_SUB_REASONS[number];

/** A fingerprint is lowercase SHA-256 hex; the wire format also takes upper case. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Largest line the verifier accepts: `review_findings.line` is a Postgres
 * `integer` (int4), and a larger value would fail the result insert with a
 * database error instead of a refusal.
 */
const LINE_MAX = 2_147_483_647;

/** Postgres `text` cannot hold U+0000, so no report text may carry one. */
const NUL = "\u0000";

/**
 * True when `text` is a usable finding path or detail: 1 to `maxLength`
 * characters, not blank after `String.prototype.trim` (every ECMAScript
 * whitespace and line terminator, including U+00A0 and U+FEFF), free of
 * U+0000, and well formed UTF-16. A lone surrogate survives a JavaScript string
 * but Postgres `jsonb` rejects it, so the report is refused here instead of
 * failing the result insert with a database error.
 */
function isReportText(text: string, maxLength: number): boolean {
  return typeof text === "string" && text.length >= 1 &&
    text.length <= maxLength && text.trim().length > 0 &&
    !text.includes(NUL) && text.isWellFormed();
}

const ReportFindingSchema = z.object({
  fingerprint: z.string().describe(
    "Worker-computed fingerprint of the issue; verifyReviewReport requires 64 lowercase hex characters, unique within the report.",
  ),
  severity: z.enum(REVIEW_SEVERITIES).describe(
    "How serious the finding is; blocker and major block delivery.",
  ),
  blocking: z.boolean().describe(
    "The worker's claim that the finding blocks delivery; the server requires it to equal the severity's rule.",
  ),
  path: z.string().describe(
    "Repository-relative path the finding concerns; bounded by verifyReviewReport.",
  ),
  line: nullable(
    z.number().int().describe("One-based line the finding points at."),
    "the finding concerns the whole file.",
  ),
  detail: z.string().describe(
    "Human-readable explanation of the finding; bounded by verifyReviewReport.",
  ),
}).strict().describe(
  "One worker-reported review finding; every field is a claim.",
);

export const ReviewReportSchema = z.object({
  reviewId: z.uuid().describe(
    "Identifier the reviewer generated for this review; it becomes the recorded cycle's id.",
  ),
  sessionId: z.uuid().describe(
    "Agent session the worker says it reviewed in; the independence rules decide whether the server believes it.",
  ),
  headSha: z.string().describe("Commit the worker says it reviewed."),
  baseSha: z.string().describe("Base commit the worker says it echoed."),
  policyDigest: z.string().describe(
    "Effective policy digest the worker says it reviewed under.",
  ),
  findings: z.array(ReportFindingSchema).describe(
    "Findings in the order the worker reported them.",
  ),
  blockingFindings: z.number().int().describe(
    "The worker's count of blocking findings; the server recomputes it from the findings.",
  ),
}).strict().describe(
  "A review.independent result as reported by the worker; every field is a claim.",
);

export type ReviewReport = z.output<typeof ReviewReportSchema>;
export type ReviewReportFinding = ReviewReport["findings"][number];

/** The bounds `verifyReviewReport` enforces; frozen into a run at admission. */
export type ReviewReportLimits = {
  /** Most findings one report may hold. */
  readonly maxFindings: number;
  /** Most canonical-JSON bytes one report may take. */
  readonly resultByteBudget: number;
};

function reject(subReason: ReviewReportSubReason): never {
  throw new StandardError({
    code: "VALIDATION_FAILED",
    params: { reason: REVIEW_REPORT_INVALID_REASON, subReason },
  });
}

/**
 * Parses a result payload into a report, or refuses it with sub-reason
 * `shape`. The parse is strict: an unknown field, a wrong type or a missing
 * field is refused. Bounds and cross-field rules belong to
 * `verifyReviewReport`, so each rule has exactly one place and one sub-reason.
 */
export function parseReviewReport(payload: unknown): ReviewReport {
  const parsed = ReviewReportSchema.safeParse(payload);
  if (!parsed.success) reject("shape");
  return parsed.data;
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Verifies a report against the pins and the limits. Pure: throws
 * `VALIDATION_FAILED` with reason `review_report_invalid` and a sub-reason, and
 * writes nothing. A report passes only when:
 *
 * - its head, base and policy digest equal the pins;
 * - it holds at most `maxFindings` findings;
 * - every finding has a 64-character lowercase hex fingerprint, a path of 1 to
 *   200 characters, a detail of 1 to 500 characters (neither blank after
 *   `trim()`, nor holding U+0000 which Postgres `text` rejects, nor holding a
 *   lone surrogate which Postgres `jsonb` rejects), a line that is
 *   null or an integer from 1 to 2147483647 (the int4 column), and a
 *   `blocking` flag equal to what its severity means;
 * - fingerprints are unique, so one issue is one finding;
 * - `blockingFindings` equals the number of blocking findings;
 * - its canonical JSON is at most `resultByteBudget` bytes.
 *
 * The checks run in that order. The limits are the caller's frozen values; a
 * limit that is not a non-negative integer is a programming error and throws a
 * plain error rather than silently accepting everything.
 */
export function verifyReviewReport(
  report: ReviewReport,
  pins: Pick<ReviewPins, "headSha" | "baseSha" | "policyDigest">,
  limits: ReviewReportLimits,
): void {
  if (!isCount(limits.maxFindings) || !isCount(limits.resultByteBudget)) {
    throw new Error("REVIEW_REPORT_LIMITS_INVALID");
  }
  if (report.headSha !== pins.headSha) reject("head_mismatch");
  if (report.baseSha !== pins.baseSha) reject("base_mismatch");
  if (report.policyDigest !== pins.policyDigest) reject("policy_mismatch");
  if (report.findings.length > limits.maxFindings) {
    reject("findings_over_limit");
  }
  const fingerprints = new Set<string>();
  let blocking = 0;
  for (const finding of report.findings) {
    if (!FINGERPRINT_PATTERN.test(finding.fingerprint)) {
      reject("fingerprint_invalid");
    }
    if (fingerprints.has(finding.fingerprint)) reject("fingerprint_duplicate");
    fingerprints.add(finding.fingerprint);
    if (!isReportText(finding.path, REVIEW_FINDING_PATH_MAX_LENGTH)) {
      reject("path_invalid");
    }
    if (!isReportText(finding.detail, REVIEW_FINDING_DETAIL_MAX_LENGTH)) {
      reject("detail_invalid");
    }
    if (
      finding.line !== null &&
      !(Number.isSafeInteger(finding.line) && finding.line >= 1 &&
        finding.line <= LINE_MAX)
    ) reject("line_invalid");
    if (finding.blocking !== isBlockingSeverity(finding.severity)) {
      reject("blocking_flag_mismatch");
    }
    if (finding.blocking) blocking++;
  }
  if (report.blockingFindings !== blocking) reject("blocking_count_mismatch");
  if (serializedBytes(report) > limits.resultByteBudget) reject("over_budget");
}
