import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import {
  assertFindingsLimits,
  FINDINGS_SUB_REASONS,
  type FindingsLimits,
  ReportFindingSchema,
  REVIEW_REPORT_INVALID_REASON,
  verifyFindings,
} from "../review-loop/findings.ts";
import type { ReviewPins } from "./review-pins.ts";

/**
 * The worker's `review.independent` report as the server reads it, and the
 * rules a report must satisfy before any row is written. The registry already
 * parsed the wire shape; this parse gives typed access and fails closed if the
 * two ever disagree. Nothing in a report is an identity or an approval the
 * server believes: the server derives the head, base and policy from the job's
 * own pins, recomputes the blocking count from the findings, and only compares.
 *
 * The pack owns the pins (the commit pair and the policy digest of a code
 * review); the findings and their rules belong to the review loop module.
 */

export { REVIEW_REPORT_INVALID_REASON };

/** Which rule a refused report broke; carried as `params.subReason`. */
export const REVIEW_REPORT_SUB_REASONS = Object.freeze(
  [
    "shape",
    "head_mismatch",
    "base_mismatch",
    "policy_mismatch",
    ...FINDINGS_SUB_REASONS,
  ] as const,
);
export type ReviewReportSubReason = typeof REVIEW_REPORT_SUB_REASONS[number];

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
export type ReviewReportLimits = FindingsLimits;

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

/**
 * Verifies a report against the pins and the limits. Pure: throws
 * `VALIDATION_FAILED` with reason `review_report_invalid` and a sub-reason, and
 * writes nothing. A report passes only when its head, base and policy digest
 * equal the pins, and its findings satisfy `verifyFindings` (limits, per-finding
 * rules, unique fingerprints, the blocking count and the byte budget), in that
 * order. The limits are the caller's frozen values.
 */
export function verifyReviewReport(
  report: ReviewReport,
  pins: Pick<ReviewPins, "headSha" | "baseSha" | "policyDigest">,
  limits: ReviewReportLimits,
): void {
  // A bad limit is a programming error before it is a bad report, so it is
  // checked before the pins, as it was before the split.
  assertFindingsLimits(limits);
  if (report.headSha !== pins.headSha) reject("head_mismatch");
  if (report.baseSha !== pins.baseSha) reject("base_mismatch");
  if (report.policyDigest !== pins.policyDigest) reject("policy_mismatch");
  verifyFindings(report, limits);
}
