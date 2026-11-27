import { assert, assertEquals } from "@std/assert";
import {
  type CandidateEvidence,
  type EvidenceRefusal,
  evidenceRefusal,
  type MergeEntryCreateInput,
  sameQueuedCandidate,
} from "../../apps/server/src/modules/delivery/merge-entries.ts";

/**
 * The merge queue's admission rule over rows: only the exact reviewed candidate
 * enters the queue. Each case here is one way a candidate can be stale.
 */

const HEAD = "1".repeat(40);
const OTHER_HEAD = "2".repeat(40);
const BASE = "3".repeat(40);
const OTHER_BASE = "4".repeat(40);
const POLICY = "a".repeat(64);
const OTHER_POLICY = "b".repeat(64);
const CHECK_A = "5".repeat(8) + "-0000-4000-8000-000000000000";
const CHECK_B = "6".repeat(8) + "-0000-4000-8000-000000000000";

const input: MergeEntryCreateInput = {
  pullRequestId: "7".repeat(8) + "-0000-4000-8000-000000000000",
  repositoryId: "8".repeat(8) + "-0000-4000-8000-000000000000",
  targetBranch: "main",
  expectedHeadSha: HEAD,
  expectedBaseSha: BASE,
  runId: "9".repeat(8) + "-0000-4000-8000-000000000000",
  policyDigest: POLICY,
  reviewCycleId: "a".repeat(8) + "-0000-4000-8000-000000000000",
  checkRunIds: [CHECK_A, CHECK_B],
};

const evidence = (
  overrides: {
    pullRequest?: Partial<NonNullable<CandidateEvidence["pullRequest"]>> | null;
    review?: Partial<NonNullable<CandidateEvidence["review"]>> | null;
    checks?: CandidateEvidence["checks"];
  } = {},
): CandidateEvidence => ({
  pullRequest: overrides.pullRequest === null
    ? null
    : { headSha: HEAD, baseSha: BASE, state: "open", ...overrides.pullRequest },
  review: overrides.review === null ? null : {
    headSha: HEAD,
    baseSha: BASE,
    policyDigest: POLICY,
    blocking: 0,
    accepted: false,
    ...overrides.review,
  },
  checks: overrides.checks ?? [
    {
      id: CHECK_A,
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: POLICY,
      result: "passed",
    },
    {
      id: CHECK_B,
      headSha: HEAD,
      baseSha: BASE,
      policyDigest: POLICY,
      result: "passed",
    },
  ],
});

const refused = (result: EvidenceRefusal) => {
  assert(result !== null, "expected a refusal");
  return `${result.code}:${result.reason}`;
};

Deno.test("the exact reviewed candidate is admitted", () => {
  assertEquals(evidenceRefusal(input, evidence()), null);
});

Deno.test("an entry that names no check run is refused, never admitted on no evidence", () => {
  // The two halves of #40 must agree: #481's checksPassed([]) refuses exactly
  // this, so the queue cannot admit a candidate carrying zero check evidence.
  assertEquals(
    refused(evidenceRefusal({ ...input, checkRunIds: [] }, evidence())),
    "PRECONDITION_FAILED:check_runs_missing",
  );
  assertEquals(
    refused(
      evidenceRefusal({ ...input, checkRunIds: [] }, evidence({ checks: [] })),
    ),
    "PRECONDITION_FAILED:check_runs_missing",
  );
});

Deno.test("a head or base that moved refuses admission", () => {
  assertEquals(
    refused(evidenceRefusal(
      input,
      evidence({
        pullRequest: { headSha: OTHER_HEAD },
      }),
    )),
    "PRECONDITION_FAILED:head_moved",
  );
  assertEquals(
    refused(evidenceRefusal(
      input,
      evidence({
        pullRequest: { baseSha: OTHER_BASE },
      }),
    )),
    "PRECONDITION_FAILED:base_moved",
  );
});

Deno.test("a pull request that is no longer open, or gone, refuses admission", () => {
  assertEquals(
    refused(evidenceRefusal(
      input,
      evidence({
        pullRequest: { state: "merged" },
      }),
    )),
    "STATE_CONFLICT:pull_request_not_open",
  );
  assertEquals(
    refused(evidenceRefusal(input, evidence({ pullRequest: null }))),
    "RESOURCE_NOT_FOUND:pull_request_missing",
  );
});

Deno.test("review evidence from another candidate or policy is stale", () => {
  for (
    const review of [
      { headSha: OTHER_HEAD },
      { baseSha: OTHER_BASE },
      { policyDigest: OTHER_POLICY },
    ]
  ) {
    assertEquals(
      refused(evidenceRefusal(input, evidence({ review }))),
      "PRECONDITION_FAILED:review_evidence_stale",
    );
  }
  assertEquals(
    refused(evidenceRefusal(input, evidence({ review: null }))),
    "RESOURCE_NOT_FOUND:review_cycle_missing",
  );
});

Deno.test("a blocking review finding keeps the candidate out of the queue", () => {
  assertEquals(
    refused(evidenceRefusal(input, evidence({ review: { blocking: 1 } }))),
    "STATE_CONFLICT:review_findings_blocking",
  );
});

Deno.test("a blocking review a person accepted anyway no longer keeps the candidate out", () => {
  assertEquals(
    evidenceRefusal(
      input,
      evidence({ review: { blocking: 1, accepted: true } }),
    ),
    null,
  );
});

Deno.test("a named check run that is missing, foreign or stale refuses admission", () => {
  // Only one of the two named runs came back: one is missing or belongs to
  // another run.
  assertEquals(
    refused(evidenceRefusal(
      input,
      evidence({
        checks: [{
          id: CHECK_A,
          headSha: HEAD,
          baseSha: BASE,
          policyDigest: POLICY,
          result: "passed",
        }],
      }),
    )),
    "PRECONDITION_FAILED:check_runs_missing",
  );
  for (
    const check of [
      { headSha: OTHER_HEAD },
      { baseSha: OTHER_BASE },
      { policyDigest: OTHER_POLICY },
      { baseSha: null },
    ]
  ) {
    assertEquals(
      refused(evidenceRefusal(
        input,
        evidence({
          checks: [
            {
              id: CHECK_A,
              headSha: HEAD,
              baseSha: BASE,
              policyDigest: POLICY,
              result: "passed",
            },
            {
              id: CHECK_B,
              headSha: HEAD,
              baseSha: BASE,
              policyDigest: POLICY,
              result: "passed",
              ...check,
            },
          ],
        }),
      )),
      "PRECONDITION_FAILED:check_evidence_stale",
    );
  }
});

Deno.test("a check that did not pass keeps the candidate out", () => {
  for (const result of ["failed", "pending", "unavailable", "canceled"]) {
    assertEquals(
      refused(evidenceRefusal(
        input,
        evidence({
          checks: [
            {
              id: CHECK_A,
              headSha: HEAD,
              baseSha: BASE,
              policyDigest: POLICY,
              result,
            },
            {
              id: CHECK_B,
              headSha: HEAD,
              baseSha: BASE,
              policyDigest: POLICY,
              result: "passed",
            },
          ],
        }),
      )),
      "STATE_CONFLICT:checks_not_passed",
    );
  }
});

Deno.test("a queued entry is the same candidate by pull request, head and base alone", () => {
  const queued = {
    pullRequestId: input.pullRequestId,
    expectedHeadSha: input.expectedHeadSha,
    expectedBaseSha: input.expectedBaseSha,
  };
  // The candidate is the identity: a re-run that names the same pull request at
  // the same head and base answers with the queued entry, whatever run, policy,
  // review cycle or check ids it carries.
  assertEquals(
    sameQueuedCandidate(queued, {
      ...input,
      runId: crypto.randomUUID(),
      policyDigest: OTHER_POLICY,
      reviewCycleId: crypto.randomUUID(),
      checkRunIds: [crypto.randomUUID()],
    }),
    true,
  );
  // Any part of the candidate moving is a different candidate.
  assertEquals(
    sameQueuedCandidate(queued, {
      ...input,
      pullRequestId: crypto.randomUUID(),
    }),
    false,
  );
  assertEquals(
    sameQueuedCandidate(queued, { ...input, expectedHeadSha: OTHER_HEAD }),
    false,
  );
  assertEquals(
    sameQueuedCandidate(queued, { ...input, expectedBaseSha: OTHER_BASE }),
    false,
  );
});
