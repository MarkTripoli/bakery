import { z } from "zod";
import { effectivePolicyDigest } from "../../../packages/contracts/src/check-evidence.ts";
import { workerActionOutputSchema } from "../../../packages/contracts/src/contracts.ts";
import type { RepositoryExecutionContextSchema } from "../../../packages/contracts/src/repository-inspection.ts";
import {
  findingFingerprint,
  fitFindingsToBudget,
  isBlockingSeverity,
  REVIEW_FINDING_DETAIL_MAX_LENGTH,
  REVIEW_FINDING_PATH_MAX_LENGTH,
  REVIEW_LOOP_LIMITS,
  REVIEW_SEVERITIES,
  type ReviewSeverity,
  serializedBytes,
} from "../../../packages/contracts/src/review-evidence.ts";

/**
 * The pure half of the independent reviewer (issue #94): the shape a reviewer
 * model must answer in, and the one place that turns that answer into the
 * `ReviewOutput` the server verifies. The Claude reviewer and the scripted
 * test reviewer both build their report here, so neither can drift from the
 * contract or from the single byte-trimming rule in `@bakery/contracts`.
 */

/** Findings a reviewer model may return before trimming; four times the report cap. */
export const REVIEWER_MODEL_FINDINGS_MAX = REVIEW_LOOP_LIMITS.maxFindings * 4;

const REVIEWER_CATEGORY_MAX_LENGTH = 100;
const REVIEWER_TITLE_MAX_LENGTH = 200;

/**
 * Largest line the server accepts: `review_findings.line` is a Postgres
 * `integer`, and both the contract (`Finding.line`) and the server verifier cap
 * it there. The worker maps a larger line to `null` instead of failing the
 * whole answer.
 */
export const REVIEW_LINE_MAX = 2_147_483_647;

/** Postgres `text` cannot hold U+0000, so no report text may carry one. */
const NUL = "\u0000";

/**
 * True when `text` can be a reported path or detail the way the server
 * verifier reads it: 1 to `maxUnits` UTF-16 code units (`String.length`, so an
 * emoji counts as two), not blank after `String.prototype.trim` and free of
 * U+0000.
 */
function isReportableText(text: string, maxUnits: number): boolean {
  return text.length >= 1 && text.length <= maxUnits &&
    text.trim().length > 0 && !text.includes(NUL);
}

const reportableMessage = (maxUnits: number) =>
  `must hold a visible character, no NUL character and at most ${maxUnits} UTF-16 code units`;

/** One issue as the reviewer model reports it, before fingerprinting. */
export const ReviewerFindingSchema = z.strictObject({
  severity: z.enum(REVIEW_SEVERITIES).describe(
    "How serious the issue is: blocker or major must be fixed before delivery, minor and note are advisory.",
  ),
  category: z.string().min(1).max(REVIEWER_CATEGORY_MAX_LENGTH).describe(
    "Short stable class of the issue, such as correctness, security or error-handling; part of the fingerprint, so reuse the same wording for the same kind of issue.",
  ),
  title: z.string().min(1).max(REVIEWER_TITLE_MAX_LENGTH).describe(
    "Short stable name of the issue without line numbers; part of the fingerprint, so a repeated issue keeps its title.",
  ),
  // `.max` counts code points and is what the JSON Schema handed to the CLI
  // says; the refine counts UTF-16 code units like the server, the stricter
  // bound for astral text, so an over-long answer is refused here and never
  // reaches the report.
  path: z.string().min(1).max(REVIEW_FINDING_PATH_MAX_LENGTH).refine(
    (text) => isReportableText(text, REVIEW_FINDING_PATH_MAX_LENGTH),
    { error: `path ${reportableMessage(REVIEW_FINDING_PATH_MAX_LENGTH)}` },
  ).describe(
    "Repository-relative path of the file the issue concerns; not blank, at most 200 UTF-16 code units (an emoji counts as two).",
  ),
  line: z.number().int().min(1).nullable().describe(
    "One-based line the issue points at, or null when it concerns the whole file.",
  ),
  detail: z.string().min(1).max(REVIEW_FINDING_DETAIL_MAX_LENGTH).refine(
    (text) => isReportableText(text, REVIEW_FINDING_DETAIL_MAX_LENGTH),
    { error: `detail ${reportableMessage(REVIEW_FINDING_DETAIL_MAX_LENGTH)}` },
  ).describe(
    "Explanation of the issue and how to fix it, written for the engineer who repairs it; not blank, at most 500 UTF-16 code units (an emoji counts as two).",
  ),
}).describe("One issue found in the candidate revision under review.");

export type ReviewerFinding = z.output<typeof ReviewerFindingSchema>;

/** The whole answer of a reviewer model. */
export const ReviewerModelOutputSchema = z.strictObject({
  findings: z.array(ReviewerFindingSchema).max(REVIEWER_MODEL_FINDINGS_MAX)
    .describe(
      "Every issue found, most serious first; an empty list means the reviewer found nothing that needs attention.",
    ),
}).describe(
  "The reviewer's structured answer: the findings about the candidate revision, nothing else.",
);

/** JSON Schema handed to the CLI so the model emits only a valid answer. */
export function reviewerOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ReviewerModelOutputSchema, {
    target: "draft-7",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** The wire shape of one finding in a `ReviewOutput`. */
export type ReviewWireFinding = {
  readonly fingerprint: string;
  readonly severity: ReviewSeverity;
  readonly blocking: boolean;
  readonly path: string;
  readonly line: number | null;
  readonly detail: string;
};

/** The `ReviewOutput` a worker reports. */
export type ReviewReport = {
  readonly reviewId: string;
  readonly sessionId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly policyDigest: string;
  readonly findings: readonly ReviewWireFinding[];
  readonly blockingFindings: number;
};

/** The identities of a job that a review report must echo. */
export type ReviewIdentity = {
  readonly sessionId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly policyDigest: string;
};

const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = {
  blocker: 0,
  major: 1,
  minor: 2,
  note: 3,
};

/** A path as a reviewer writes it, without a leading `./`. */
function normalizedPath(path: string): string {
  const stripped = path.trim().replace(/^(\.\/)+/, "");
  return stripped.length === 0 ? path : stripped;
}

/**
 * Text as valid UTF-16: each lone surrogate becomes U+FFFD, one code unit for
 * one code unit, so no length bound moves (every bound that matters counts
 * UTF-16 code units, as the server does). A lone surrogate passes the server
 * verifier but Postgres
 * `jsonb` refuses it, so it must never reach a report or a fingerprint. Run
 * before the final bounds check, any truncation and any hash; truncation then
 * works on code points and cannot split a surrogate pair.
 */
function wellFormed(text: string): string {
  return text.toWellFormed();
}

/** The line the server accepts: an integer from 1 to the int4 maximum, else null. */
function wireLine(line: number | null): number | null {
  return line !== null && Number.isSafeInteger(line) && line >= 1 &&
      line <= REVIEW_LINE_MAX
    ? line
    : null;
}

/**
 * True when a finding's text and line are what the server verifier accepts:
 * path and detail within their bounds, visible, free of U+0000 and well-formed,
 * and a line that is null or from 1 to the int4 maximum. The server rule is the
 * source of truth; this is the worker's own check that nothing it sends breaks it.
 */
function isRepresentable(finding: ReviewWireFinding): boolean {
  return isReportableText(finding.path, REVIEW_FINDING_PATH_MAX_LENGTH) &&
    finding.path.isWellFormed() &&
    isReportableText(finding.detail, REVIEW_FINDING_DETAIL_MAX_LENGTH) &&
    finding.detail.isWellFormed() &&
    (finding.line === null || wireLine(finding.line) === finding.line);
}

/** One model finding as it goes on the wire, fingerprinted. */
async function wireFinding(
  finding: ReviewerFinding,
): Promise<ReviewWireFinding> {
  const path = normalizedPath(wellFormed(finding.path));
  return {
    fingerprint: await findingFingerprint({
      path,
      category: wellFormed(finding.category),
      title: wellFormed(finding.title),
    }),
    severity: finding.severity,
    blocking: isBlockingSeverity(finding.severity),
    path,
    line: wireLine(finding.line),
    // Trimmed so that every prefix the byte rule later cuts still holds a
    // visible character: a detail that starts with whitespace could otherwise
    // be shortened to a blank one.
    detail: wellFormed(finding.detail).trim(),
  };
}

/**
 * Two findings with the same fingerprint are the same issue: the more severe
 * one is kept, and the first when they tie, so a repeated issue never inflates
 * the report.
 */
function collapseDuplicates(
  findings: readonly ReviewWireFinding[],
): ReviewWireFinding[] {
  const byFingerprint = new Map<string, ReviewWireFinding>();
  for (const wire of findings) {
    const kept = byFingerprint.get(wire.fingerprint);
    if (
      kept === undefined ||
      SEVERITY_RANK[wire.severity] < SEVERITY_RANK[kept.severity]
    ) byFingerprint.set(wire.fingerprint, wire);
  }
  return [...byFingerprint.values()];
}

/** Result of assembling a report: the report, or proof that blockers cannot fit. */
export type AssembledReview =
  | { readonly status: "ok"; readonly report: ReviewReport }
  | { readonly status: "findings_limit" }
  | { readonly status: "invalid" };

/**
 * Builds the report from the model's findings. The shared budget rule orders
 * findings blocker first and, until the report fits the finding cap and the
 * byte budget, shortens non-blocking details, drops non-blocking findings from
 * the least severe end and only then shortens blocking details. When even that
 * leaves a blocker out, the result is `findings_limit`: a worker never hides a
 * blocker to make a report fit. `invalid` means a finding cannot be
 * represented the way the server verifier needs (blank or NUL text, a path or
 * detail out of bounds, a line out of range) or the finished report does not
 * satisfy the `review.independent` output contract. A finding is never dropped
 * or rewritten into something that merely looks valid: the whole answer is
 * refused, so an unusable finding can not turn into a clean-looking report.
 * Lone surrogates are not refused: they are replaced before any check, and a
 * line above the int4 maximum is sent as null.
 */
export async function assembleReviewReport(
  identity: ReviewIdentity,
  findings: readonly ReviewerFinding[],
): Promise<AssembledReview> {
  const reviewId = crypto.randomUUID();
  const all = await Promise.all(findings.map(wireFinding));
  // Every finding the model gave, before duplicates collapse or the byte rule
  // drops any: an unusable one refuses the answer instead of vanishing.
  if (!all.every(isRepresentable)) return { status: "invalid" };
  const wire = collapseDuplicates(all);
  const reportOf = (
    candidate: readonly ReviewWireFinding[],
  ): ReviewReport => ({
    reviewId,
    sessionId: identity.sessionId,
    headSha: identity.headSha,
    baseSha: identity.baseSha,
    policyDigest: identity.policyDigest,
    findings: candidate,
    blockingFindings: candidate.filter((finding) => finding.blocking).length,
  });
  const fitted = fitFindingsToBudget(
    wire,
    (candidate) =>
      candidate.length <= REVIEW_LOOP_LIMITS.maxFindings &&
      serializedBytes(reportOf(candidate)) <=
        REVIEW_LOOP_LIMITS.resultByteBudget,
  );
  if (fitted === null) return { status: "findings_limit" };
  // The byte rule shortens details; what it leaves must still be sendable.
  if (!fitted.every(isRepresentable)) return { status: "invalid" };
  const report = reportOf(fitted);
  return workerActionOutputSchema("review.independent").safeParse(report)
      .success
    ? { status: "ok", report }
    : { status: "invalid" };
}

type ExecutionContext = z.output<typeof RepositoryExecutionContextSchema>;

/**
 * The pins a review report echoes, read from the job's repository profile the
 * way the check runner reads them: the profile's base commit and the effective
 * policy digest of the fixed policy, the trusted checker and the pinned rules.
 * Null when the profile carries no fixed policy or no base commit, so the job
 * cannot be judged against a policy.
 */
export async function reviewPinsFromProfile(
  profile: ExecutionContext,
): Promise<{ readonly baseSha: string; readonly policyDigest: string } | null> {
  if (
    profile.config.schemaVersion !== 2 ||
    profile.config.fixedPolicy === undefined || profile.baseSha === null ||
    profile.fixedPolicyDigest === undefined ||
    profile.trustedCheckerConfigDigest === undefined
  ) return null;
  return {
    baseSha: profile.baseSha,
    policyDigest: await effectivePolicyDigest({
      fixedPolicyDigest: profile.fixedPolicyDigest,
      trustedCheckerConfigDigest: profile.trustedCheckerConfigDigest,
      entries: profile.repositoryRules?.entries ?? [],
    }),
  };
}
