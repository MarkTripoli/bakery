import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import {
  isBlockingSeverity,
  REVIEW_FINDING_DETAIL_MAX_LENGTH,
  REVIEW_FINDING_PATH_MAX_LENGTH,
  REVIEW_SEVERITIES,
  serializedBytes,
} from "@bakery/contracts/review-evidence";

/**
 * The findings convention of the review loop: what one reported finding looks
 * like and the rules a list of findings must satisfy before any row is
 * written. It knows nothing of what is under review; a pack that reviews code,
 * a document or a render binds its own pins around it and calls
 * `verifyFindings` for the rest.
 */

/** `VALIDATION_FAILED` reason: the report contradicts what the server derived. */
export const REVIEW_REPORT_INVALID_REASON = "review_report_invalid";

/** The sub-reasons `verifyFindings` itself can give; carried as `params.subReason`. */
export const FINDINGS_SUB_REASONS = Object.freeze(
  [
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
export type FindingsSubReason = typeof FINDINGS_SUB_REASONS[number];

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

export const ReportFindingSchema = z.object({
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
  line: z.union([
    z.number().int().describe("One-based line the finding points at."),
    z.null().describe("the finding concerns the whole file."),
  ]).describe(
    "One-based line the finding points at. Null means: the finding concerns the whole file.",
  ),
  detail: z.string().describe(
    "Human-readable explanation of the finding; bounded by verifyReviewReport.",
  ),
}).strict().describe(
  "One worker-reported review finding; every field is a claim.",
);

export type ReportFinding = z.output<typeof ReportFindingSchema>;

/** The bounds `verifyFindings` enforces; frozen into a run at admission. */
export type FindingsLimits = {
  /** Most findings one report may hold. */
  readonly maxFindings: number;
  /** Most canonical-JSON bytes one report may take. */
  readonly resultByteBudget: number;
};

/** Refuses a report with `VALIDATION_FAILED`, reason `review_report_invalid` and a sub-reason. */
export function rejectReport(subReason: string): never {
  throw new StandardError({
    code: "VALIDATION_FAILED",
    params: { reason: REVIEW_REPORT_INVALID_REASON, subReason },
  });
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/** A limit that is not a non-negative integer is a programming error, never a refusal. */
export function assertFindingsLimits(limits: FindingsLimits): void {
  if (!isCount(limits.maxFindings) || !isCount(limits.resultByteBudget)) {
    throw new Error("REVIEW_REPORT_LIMITS_INVALID");
  }
}

/**
 * Verifies the findings of a report against the limits. Pure: throws
 * `VALIDATION_FAILED` with reason `review_report_invalid` and a sub-reason, and
 * writes nothing. The findings pass only when:
 *
 * - there are at most `maxFindings` of them;
 * - every finding has a 64-character lowercase hex fingerprint, a path of 1 to
 *   200 characters, a detail of 1 to 500 characters (neither blank after
 *   `trim()`, nor holding U+0000 which Postgres `text` rejects, nor holding a
 *   lone surrogate which Postgres `jsonb` rejects), a line that is
 *   null or an integer from 1 to 2147483647 (the int4 column), and a
 *   `blocking` flag equal to what its severity means;
 * - fingerprints are unique, so one issue is one finding;
 * - `blockingFindings` equals the number of blocking findings;
 * - the canonical JSON of the whole report is at most `resultByteBudget` bytes.
 *
 * The checks run in that order. The limits are the caller's frozen values; a
 * limit that is not a non-negative integer is a programming error and throws a
 * plain error rather than silently accepting everything.
 */
export function verifyFindings(
  report: {
    readonly findings: readonly ReportFinding[];
    readonly blockingFindings: number;
  },
  limits: FindingsLimits,
): void {
  assertFindingsLimits(limits);
  if (report.findings.length > limits.maxFindings) {
    rejectReport("findings_over_limit");
  }
  const fingerprints = new Set<string>();
  let blocking = 0;
  for (const finding of report.findings) {
    if (!FINGERPRINT_PATTERN.test(finding.fingerprint)) {
      rejectReport("fingerprint_invalid");
    }
    if (fingerprints.has(finding.fingerprint)) {
      rejectReport("fingerprint_duplicate");
    }
    fingerprints.add(finding.fingerprint);
    if (!isReportText(finding.path, REVIEW_FINDING_PATH_MAX_LENGTH)) {
      rejectReport("path_invalid");
    }
    if (!isReportText(finding.detail, REVIEW_FINDING_DETAIL_MAX_LENGTH)) {
      rejectReport("detail_invalid");
    }
    if (
      finding.line !== null &&
      !(Number.isSafeInteger(finding.line) && finding.line >= 1 &&
        finding.line <= LINE_MAX)
    ) rejectReport("line_invalid");
    if (finding.blocking !== isBlockingSeverity(finding.severity)) {
      rejectReport("blocking_flag_mismatch");
    }
    if (finding.blocking) blocking++;
  }
  if (report.blockingFindings !== blocking) {
    rejectReport("blocking_count_mismatch");
  }
  if (serializedBytes(report) > limits.resultByteBudget) {
    rejectReport("over_budget");
  }
}
