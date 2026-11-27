import { assert, assertEquals } from "@std/assert";
import {
  approvalsForRun,
  type DeliveryApproval,
  type DeliveryCheck,
  type DeliveryDecision,
  type DeliveryFinding,
  type DeliveryInput,
  type DeliveryMergeAttempt,
  type DeliveryMergeEntry,
  type DeliveryModel,
  deliveryModel,
  type DeliveryPullRequest,
  type DeliveryReview,
  findingTitle,
  type ListedApproval,
  type NowCard,
} from "../../apps/web/src/pages/task-delivery/model.ts";

const OLD = "4be19c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "91d0aa3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BASE = "a7254e7cccccccccccccccccccccccccccccccc";
const POLICY = "c".repeat(64);
const REPOSITORY = "3f0d1c2e-0000-4000-8000-0000000000c3";
const RUN = "3f0d1c2e-0000-4000-8000-0000000000a1";
const OTHER_RUN = "3f0d1c2e-0000-4000-8000-0000000000b2";

const check = (
  over: Partial<DeliveryCheck> & Pick<DeliveryCheck, "id" | "checkId">,
): DeliveryCheck => ({
  checkName: over.checkId,
  headSha: NEW,
  result: "passed",
  exitCode: 0,
  durationMs: 1000,
  createdAt: "2026-11-13T10:00:00.000Z",
  ...over,
});

const review = (over: Partial<DeliveryReview> = {}): DeliveryReview => ({
  id: "r0",
  ordinal: 0,
  headSha: NEW,
  policyDigest: POLICY,
  status: "approved",
  findingCount: 0,
  blockingCount: 0,
  createdAt: "2026-11-13T10:01:00.000Z",
  ...over,
});

const finding = (
  over: Partial<DeliveryFinding> & Pick<DeliveryFinding, "id">,
): DeliveryFinding => ({
  severity: "note",
  path: "src/a.ts",
  line: 1,
  body: "A finding.",
  status: "open",
  ...over,
});

const decision = (
  over: Partial<DeliveryDecision> & Pick<DeliveryDecision, "ordinal">,
): DeliveryDecision => ({
  id: `d${over.ordinal}`,
  decision: "proceed",
  reason: "clean",
  headSha: NEW,
  blockingFingerprints: [],
  limits: { maxRepairCycles: 2 },
  createdAt: `2026-11-13T10:0${over.ordinal}:00.000Z`,
  ...over,
});

/** The Fixing step without its list of tries and limits, which have their own tests. */
const summary = (fixing: DeliveryModel["fixing"]) => {
  if (fixing === null) return null;
  const { tries: _tries, limits: _limits, ...rest } = fixing;
  return rest;
};

const input = (over: Partial<DeliveryInput> = {}): DeliveryInput => ({
  runId: RUN,
  checks: [],
  reviews: [],
  findings: [],
  decisions: [],
  approvals: [],
  pullRequests: [],
  mergeAttempts: [],
  mergeEntries: [],
  mergeUnavailable: false,
  approvalsUnavailable: false,
  revisionHeadSha: null,
  baseSha: "a7254e7cccccccccccccccccccccccccccccccc",
  paused: false,
  ...over,
});

Deno.test("nothing to show until there are changes", () => {
  const model = deliveryModel(input());
  assertEquals(model.visible, false);
  assertEquals(model.headSha, null);
});

Deno.test("the current commit is the revision's, else the newest check or review", () => {
  const checks = [check({ id: "c1", checkId: "tests", headSha: OLD })];
  const reviews = [review({
    headSha: NEW,
    createdAt: "2026-11-13T11:00:00.000Z",
  })];
  assertEquals(
    deliveryModel(input({ checks, reviews, revisionHeadSha: OLD })).headSha,
    OLD,
    "the revision's head wins even when a newer review exists",
  );
  assertEquals(deliveryModel(input({ checks, reviews })).headSha, NEW);
  assertEquals(deliveryModel(input({ checks })).headSha, OLD);
  assertEquals(
    deliveryModel(input({ revisionHeadSha: NEW })).visible,
    true,
    "a commit with no results yet is still changes to show",
  );
});

Deno.test("results for an older commit are marked and never count as passed", () => {
  const model = deliveryModel(input({
    revisionHeadSha: NEW,
    checks: [
      check({ id: "c1", checkId: "tests", headSha: OLD }),
      check({ id: "c2", checkId: "lint", headSha: NEW }),
    ],
    reviews: [review({ headSha: OLD })],
  }));
  assertEquals(model.outOfDate, true);
  assertEquals(model.checks.passed, 1, "only the current commit's result");
  assertEquals(model.checks.total, 1);
  assertEquals(
    model.checks.rows.find((row) => row.name === "tests")?.olderSha,
    "4be19c2",
  );
  assertEquals(
    model.checks.rows.find((row) => row.name === "lint")?.olderSha,
    null,
  );
  assertEquals(model.review?.olderSha, "4be19c2");
});

Deno.test("a stale-evidence decision is the out-of-date notice, and the card says checking", () => {
  const model = deliveryModel(input({
    revisionHeadSha: NEW,
    checks: [check({ id: "c1", checkId: "tests" })],
    reviews: [review()],
    decisions: [
      decision({ ordinal: 0, decision: "stop", reason: "stale_evidence" }),
    ],
  }));
  assertEquals(model.outOfDate, true);
  assertEquals(model.now, { kind: "checking" });
});

Deno.test("a check shows its newest result only", () => {
  const model = deliveryModel(input({
    checks: [
      check({
        id: "c1",
        checkId: "tests",
        result: "failed",
        createdAt: "2026-11-13T10:00:00.000Z",
      }),
      check({
        id: "c2",
        checkId: "tests",
        result: "passed",
        createdAt: "2026-11-13T10:05:00.000Z",
      }),
    ],
  }));
  assertEquals(model.checks.rows.map((row) => row.id), ["c2"]);
  assertEquals([model.checks.passed, model.checks.failed], [1, 0]);
});

Deno.test("counts every check result on the current commit", () => {
  const results = [
    "passed",
    "failed",
    "pending",
    "unavailable",
    "canceled",
  ] as const;
  const model = deliveryModel(input({
    checks: results.map((result, index) =>
      check({ id: `c${index}`, checkId: `k${index}`, result })
    ),
  }));
  assertEquals(
    [
      model.checks.total,
      model.checks.passed,
      model.checks.failed,
      model.checks.running,
      model.checks.unavailable,
      model.checks.canceled,
    ],
    [5, 1, 1, 1, 1, 1],
  );
});

Deno.test("the review lists open findings, blocking first, and counts the rest", () => {
  const model = deliveryModel(input({
    reviews: [review({
      status: "changes_requested",
      findingCount: 4,
      blockingCount: 2,
    })],
    findings: [
      finding({ id: "n", severity: "note" }),
      finding({ id: "m", severity: "major" }),
      finding({ id: "x", severity: "minor", status: "resolved" }),
      finding({ id: "b", severity: "blocker" }),
    ],
  }));
  assertEquals(model.review?.status, "changesRequested");
  assertEquals(model.review?.findings.map((entry) => entry.id), [
    "b",
    "m",
    "n",
  ]);
  assertEquals(model.review?.findings.map((entry) => entry.blocking), [
    true,
    true,
    false,
  ]);
  assertEquals([model.review?.blocking, model.review?.others], [2, 2]);
});

Deno.test("the newest review cycle governs, by ordinal", () => {
  const model = deliveryModel(input({
    reviews: [
      review({ id: "r1", ordinal: 1, status: "approved" }),
      review({ id: "r0", ordinal: 0, status: "changes_requested" }),
    ],
  }));
  assertEquals(model.review?.status, "approved");
});

Deno.test("an attempt is a repair decision; the maximum is the latest decision's limit", () => {
  const none = deliveryModel(input({
    reviews: [review({ status: "changes_requested" })],
  }));
  assertEquals(none.fixing, null, "no fix attempted, no Fixing step");
  const model = deliveryModel(input({
    reviews: [review({ status: "changes_requested" })],
    decisions: [
      decision({ ordinal: 0, decision: "repair", reason: "repair_selected" }),
      decision({
        ordinal: 1,
        decision: "repair",
        reason: "repair_selected",
        limits: { maxRepairCycles: 3 },
      }),
    ],
  }));
  assertEquals(summary(model.fixing), {
    attempt: 2,
    max: 3,
    running: true,
    stopped: false,
    blocking: 0,
  });
  assertEquals(model.now, { kind: "fixing", attempt: 2, max: 3 });
});

Deno.test("the maximum defaults to two when no decision has been made", () => {
  const model = deliveryModel(input({
    reviews: [review({ status: "changes_requested" })],
    decisions: [],
  }));
  assertEquals(model.fixing, null);
});

Deno.test("each stop reason gives a stopped card with what the sentence needs", () => {
  const stopped = (reason: string, extra: Partial<DeliveryInput> = {}) =>
    deliveryModel(input({
      reviews: [review({
        status: "changes_requested",
        findingCount: 1,
        blockingCount: 1,
      })],
      findings: [finding({
        id: "b",
        severity: "blocker",
        body: "Refund amount is not validated.\nMore detail.",
      })],
      decisions: [
        decision({ ordinal: 0, decision: "repair", reason: "repair_selected" }),
        decision({
          ordinal: 1,
          decision: "stop",
          reason,
          blockingFingerprints: ["f1", "f2"],
        }),
      ],
      ...extra,
    })).now;
  for (
    const reason of [
      "repair_cycles_exhausted",
      "repair_time_exhausted",
      "repair_budget_exhausted",
      "repeated_blocker",
      "checks_unavailable",
      "reviewer_unavailable",
      "review_failed",
      "policy_missing",
    ]
  ) {
    const card = stopped(reason);
    assertEquals(card.kind, "stopped", reason);
  }
  assertEquals(stopped("repair_cycles_exhausted"), {
    kind: "stopped",
    reason: "repair_cycles_exhausted",
    max: 2,
    blocking: 2,
    unavailableChecks: 0,
    findingTitle: "Refund amount is not validated.",
    merged: false,
  });
});

Deno.test("a stopped card says a merge happened only when an attempt merged", () => {
  const stopped = (attempts: Parameters<typeof attempt>[0][]) =>
    deliveryModel(input({
      reviews: [review({
        status: "changes_requested",
        findingCount: 1,
        blockingCount: 1,
      })],
      findings: [finding({ id: "b", severity: "blocker" })],
      decisions: [
        decision({ ordinal: 0, decision: "repair", reason: "repair_selected" }),
        decision({
          ordinal: 1,
          decision: "stop",
          reason: "repair_cycles_exhausted",
          blockingFingerprints: ["f1"],
        }),
      ],
      mergeAttempts: attempts.map((one) => attempt(one)),
    })).now;
  const merged = (card: unknown) => (card as { merged: boolean }).merged;
  assertEquals(merged(stopped([])), false);
  assertEquals(merged(stopped([{ state: "refused" }])), false);
  assertEquals(merged(stopped([{ state: "unknown" }])), false);
  assertEquals(merged(stopped([{ state: "merged" }])), true);
});

Deno.test("the headline counts every check that did not pass: failed, could not run and canceled", () => {
  const model = deliveryModel(input({
    checks: [
      check({ id: "c1", checkId: "a", result: "failed", exitCode: 1 }),
      check({ id: "c2", checkId: "b", result: "unavailable" }),
      check({ id: "c3", checkId: "c", result: "canceled" }),
      check({ id: "c4", checkId: "d", result: "passed" }),
    ],
    reviews: [review()],
  }));
  assertEquals(model.now, { kind: "checksFailed", failed: 3 });
});

Deno.test("a review accepted anyway leaves no blocking finding remaining and no stop", () => {
  const model = deliveryModel(input({
    reviews: [review({
      status: "changes_requested",
      findingCount: 1,
      blockingCount: 1,
      acceptedAt: "2026-11-13T12:00:00.000Z",
      acceptReason: "Known and tracked",
      acceptedByName: "Ana",
    })],
    findings: [finding({ id: "b", severity: "blocker" })],
    decisions: [
      decision({ ordinal: 0, decision: "repair", reason: "repair_selected" }),
      decision({
        ordinal: 1,
        decision: "stop",
        reason: "repair_cycles_exhausted",
        blockingFingerprints: ["f1"],
      }),
    ],
  }));
  // The stop was about findings the person has now accepted: nothing remains.
  assertEquals(model.now.kind, "clean");
  assertEquals(model.review?.accepted?.by, "Ana");
});

Deno.test("a stopped run marks the Fixing step stopped with the blocking count", () => {
  const stopped = (reason: string) =>
    deliveryModel(input({
      reviews: [review({
        status: "changes_requested",
        findingCount: 1,
        blockingCount: 1,
      })],
      findings: [finding({ id: "b", severity: "blocker" })],
      decisions: [
        decision({ ordinal: 0, decision: "repair", reason: "repair_selected" }),
        decision({
          ordinal: 1,
          decision: "stop",
          reason,
          blockingFingerprints: ["f1", "f2"],
        }),
      ],
    })).fixing;
  assertEquals(summary(stopped("repair_cycles_exhausted")), {
    attempt: 1,
    max: 2,
    running: false,
    stopped: true,
    blocking: 2,
  });
  assertEquals(
    stopped("stale_evidence")?.stopped,
    false,
    "stale evidence is the out-of-date notice, not a stop",
  );
  assertEquals(
    stopped("something_new")?.stopped,
    false,
    "an unknown reason is not drawn as a stop",
  );
});

Deno.test("an unknown stop reason is not drawn as a stop", () => {
  const model = deliveryModel(input({
    reviews: [review({ status: "changes_requested" })],
    decisions: [
      decision({ ordinal: 0, decision: "stop", reason: "something_new" }),
    ],
  }));
  assertEquals(model.now, { kind: "checking" });
});

Deno.test("checks_unavailable carries how many checks have no result", () => {
  const model = deliveryModel(input({
    checks: [
      check({ id: "c1", checkId: "a", result: "unavailable" }),
      check({ id: "c2", checkId: "b", result: "unavailable" }),
    ],
    reviews: [review()],
    decisions: [
      decision({ ordinal: 0, decision: "stop", reason: "checks_unavailable" }),
    ],
  }));
  assertEquals(
    model.now.kind === "stopped" && model.now.unavailableChecks,
    2,
  );
});

Deno.test("the card is clean, checks failed, checking or paused from the rows alone", () => {
  assertEquals(
    deliveryModel(input({
      checks: [check({ id: "c1", checkId: "t" })],
      reviews: [review()],
    })).now,
    { kind: "clean" },
  );
  assertEquals(
    deliveryModel(input({
      checks: [check({ id: "c1", checkId: "t", result: "failed" })],
      reviews: [review()],
    })).now,
    { kind: "checksFailed", failed: 1 },
  );
  assertEquals(
    deliveryModel(input({
      checks: [check({ id: "c1", checkId: "t", result: "pending" })],
      reviews: [review()],
    })).now,
    { kind: "checking" },
  );
  assertEquals(
    deliveryModel(input({
      checks: [check({ id: "c1", checkId: "t" })],
      reviews: [review({ status: "running" })],
    })).now,
    { kind: "checking" },
  );
  assertEquals(
    deliveryModel(input({
      checks: [check({ id: "c1", checkId: "t" })],
      reviews: [review()],
      paused: true,
    })).now,
    { kind: "paused" },
  );
});

Deno.test("findingTitle takes the first non-empty line and trims long ones", () => {
  assertEquals(findingTitle("\n  First line.  \nSecond."), "First line.");
  assertEquals(findingTitle("x".repeat(120)).length, 80);
  assertEquals(findingTitle(""), "");
});

const approval = (over: Partial<DeliveryApproval> = {}): DeliveryApproval => ({
  id: "a0",
  version: 1,
  status: "open",
  decision: null,
  subjectId: "d0",
  createdAt: "2026-11-13T10:05:00.000Z",
  ...over,
});

/** A clean candidate: checks passed, review approved, the loop let it proceed. */
const clean = (over: Partial<DeliveryInput> = {}): DeliveryInput =>
  input({
    checks: [check({ id: "c1", checkId: "tests" })],
    reviews: [review()],
    decisions: [decision({ ordinal: 0 })],
    revisionHeadSha: NEW,
    ...over,
  });

const listed = (over: Partial<ListedApproval> = {}): ListedApproval => ({
  id: "a0",
  version: 1,
  status: "open",
  decision: null,
  subjectType: "run_stage",
  subjectId: "d0",
  scope: { stage: "review", runId: "run-1", headSha: NEW },
  createdAt: "2026-11-13T10:05:00.000Z",
  ...over,
});

Deno.test("only this run's run-stage approvals are read, by the run in their scope", () => {
  const rows = [
    listed({ id: "mine" }),
    listed({ id: "other-run", scope: { runId: "run-2" } }),
    listed({ id: "plan", subjectType: "plan_revision" }),
    listed({ id: "no-scope", scope: null }),
    listed({ id: "string-scope", scope: "run-1" }),
    listed({ id: "answered", status: "answered", decision: "reject" }),
    listed({ id: "odd", status: "answered", decision: "maybe" }),
  ];
  const read = approvalsForRun(rows, "run-1");
  assertEquals(read.map((entry) => entry.id), ["mine", "answered", "odd"]);
  assertEquals(read[1]?.decision, "reject");
  assertEquals(
    read[2]?.decision,
    null,
    "a decision the page does not know is not carried as one",
  );
  assertEquals(read[0]?.subjectId, "d0");
  assertEquals(read[0]?.version, 1);
});

Deno.test("an open approval on a clean candidate asks for the person's decision", () => {
  const model = deliveryModel(clean({ approvals: [approval()] }));
  assertEquals(model.now, { kind: "approval" });
  assertEquals(model.approval, { id: "a0", version: 1, state: "waiting" });
});

Deno.test("with no approval asked, a clean candidate is clean and has no approval step", () => {
  const model = deliveryModel(clean());
  assertEquals(model.now, { kind: "clean" });
  assertEquals(model.approval, null);
});

Deno.test("an approval asked about an earlier decision is not current", () => {
  const model = deliveryModel(clean({
    decisions: [
      decision({ ordinal: 0 }),
      decision({ ordinal: 1, headSha: OLD }),
    ],
    approvals: [approval({ subjectId: "d0" })],
  }));
  assertEquals(model.approval, null);
  assertEquals(model.now, { kind: "clean" });
});

Deno.test("the newest approval for the latest decision governs", () => {
  const model = deliveryModel(clean({
    approvals: [
      approval({ id: "old", status: "expired" }),
      approval({
        id: "new",
        version: 3,
        createdAt: "2026-11-13T10:09:00.000Z",
      }),
    ],
  }));
  assertEquals(model.approval, { id: "new", version: 3, state: "waiting" });
});

Deno.test("results for an older commit cannot be approved: the card keeps saying checking", () => {
  const model = deliveryModel(clean({
    checks: [
      check({ id: "c1", checkId: "tests" }),
      check({ id: "c2", checkId: "lint", headSha: OLD }),
    ],
    approvals: [approval()],
  }));
  assertEquals(model.outOfDate, true);
  assertEquals(model.now, { kind: "checking" });
  assertEquals(model.approval?.state, "waiting");
});

Deno.test("each decision gives its own state and card", () => {
  const cases: [
    DeliveryApproval["decision"],
    string,
    DeliveryInput["approvals"][number]["status"],
    string,
  ][] = [
    ["approve", "approved", "answered", "approved"],
    ["approve", "approved", "consumed", "approved"],
    ["request_changes", "changesRequested", "answered", "changesRequested"],
    ["reject", "rejected", "answered", "rejected"],
  ];
  for (const [choice, state, status, card] of cases) {
    const model = deliveryModel(clean({
      approvals: [approval({ status, decision: choice })],
    }));
    assertEquals(model.approval?.state, state, `${choice} ${status}`);
    assertEquals(model.now.kind, card, `${choice} ${status}`);
  }
});

Deno.test("an approval that ended without a decision is closed and the card is clean", () => {
  for (
    const status of ["expired", "withdrawn", "revoked", "superseded"] as const
  ) {
    const model = deliveryModel(clean({ approvals: [approval({ status })] }));
    assertEquals(model.approval?.state, "closed", status);
    assertEquals(model.now, { kind: "clean" }, status);
  }
});

Deno.test("failed checks come before an open approval, and a pause before both", () => {
  const failing = clean({
    checks: [check({ id: "c1", checkId: "tests", result: "failed" })],
    approvals: [approval()],
  });
  assertEquals(deliveryModel(failing).now, { kind: "checksFailed", failed: 1 });
  assertEquals(
    deliveryModel(clean({ approvals: [approval()], paused: true })).now,
    { kind: "paused" },
  );
});

Deno.test("a repair after the approval was asked leaves no current approval", () => {
  const model = deliveryModel(clean({
    decisions: [
      decision({ ordinal: 0 }),
      decision({ ordinal: 1, decision: "repair", reason: "blocking_findings" }),
    ],
    approvals: [approval({ status: "answered", decision: "request_changes" })],
  }));
  assertEquals(model.approval, null);
  assertEquals(model.now.kind, "fixing");
});

Deno.test("an approvals read that failed never reads as nothing waiting", () => {
  const model = deliveryModel(clean({ approvalsUnavailable: true }));
  assertEquals(model.now, { kind: "approvalUnknown" });
  assertEquals(model.approval, null);
});

Deno.test("a known approval wins over a failed read, and failed checks over both", () => {
  assertEquals(
    deliveryModel(clean({
      approvals: [approval()],
      approvalsUnavailable: true,
    })).now,
    { kind: "approval" },
    "an approval already read is still shown",
  );
  assertEquals(
    deliveryModel(clean({
      approvals: [approval({ status: "answered", decision: "approve" })],
      approvalsUnavailable: true,
    })).now,
    { kind: "approved" },
  );
  assertEquals(
    deliveryModel(clean({
      checks: [check({ id: "c1", checkId: "tests", result: "failed" })],
      approvalsUnavailable: true,
    })).now,
    { kind: "checksFailed", failed: 1 },
  );
});

Deno.test("a failed approvals read says nothing while the run is still being checked", () => {
  const model = deliveryModel(clean({
    reviews: [review({ status: "running" })],
    approvalsUnavailable: true,
  }));
  assertEquals(model.now, { kind: "checking" });
});

// ---- the "After approval" group: the pull request and the merge GitHub saw.

const pullRequest = (
  over:
    & Partial<DeliveryPullRequest>
    & Pick<DeliveryPullRequest, "providerNumber">,
): DeliveryPullRequest => ({
  id: `p${over.providerNumber}`,
  runId: null,
  url: `https://github.com/o/r/pull/${over.providerNumber}`,
  status: "open",
  mergedSha: null,
  createdAt: `2026-11-13T10:0${over.providerNumber}:00.000Z`,
  repositoryId: REPOSITORY,
  headSha: NEW,
  baseSha: BASE,
  targetBranch: "main",
  mayMerge: true,
  mergeMethod: "squash",
  ...over,
});

Deno.test("no pull request recorded reads as unknown, never as merged", () => {
  const { afterApproval } = deliveryModel(clean({}));
  assertEquals(afterApproval.pullRequest, null);
  assertEquals(afterApproval.others, []);
  assertEquals(afterApproval.badge, "approved");
});

Deno.test("this run's pull request wins over a newer one from another run", () => {
  const { afterApproval } = deliveryModel(clean({
    pullRequests: [
      pullRequest({ providerNumber: 1, runId: RUN, status: "open" }),
      pullRequest({ providerNumber: 2, runId: OTHER_RUN, status: "merged" }),
    ],
  }));
  assertEquals(afterApproval.pullRequest?.providerNumber, 1);
  assertEquals(afterApproval.others.map((one) => one.providerNumber), [2]);
  assertEquals(afterApproval.badge, "waitingForMerge");
});

Deno.test("a task whose pull requests carry no run shows the most recent", () => {
  const { afterApproval } = deliveryModel(clean({
    pullRequests: [
      pullRequest({ providerNumber: 4, status: "closed" }),
      pullRequest({ providerNumber: 5, status: "open" }),
    ],
  }));
  assertEquals(afterApproval.pullRequest?.providerNumber, 5);
  // Newest first, and the shown one is not repeated in the list.
  assertEquals(afterApproval.others.map((one) => one.providerNumber), [4]);
});

Deno.test("the badge never says merged without the merge commit GitHub reported", () => {
  const merged = pullRequest({
    providerNumber: 7,
    status: "merged",
    mergedSha: "9be04c1dddddddddddddddddddddddddddddddd",
  });
  assertEquals(
    deliveryModel(clean({ pullRequests: [merged] })).afterApproval.badge,
    "merged",
  );
  assertEquals(
    deliveryModel(clean({
      pullRequests: [{ ...merged, mergedSha: null }],
    })).afterApproval.badge,
    "approved",
  );
});

Deno.test("a pull request closed without merging is not merged", () => {
  const { afterApproval } = deliveryModel(clean({
    pullRequests: [pullRequest({ providerNumber: 9, status: "closed" })],
  }));
  assertEquals(afterApproval.pullRequest?.status, "closed");
  assertEquals(afterApproval.badge, "notMerged");
});

// ---- merging from Bakery: what the person may do, from what the server said.

const attempt = (
  over: Partial<DeliveryMergeAttempt> = {},
): DeliveryMergeAttempt => ({
  id: "m1",
  state: "unknown",
  expectedHeadSha: NEW,
  createdAt: "2026-11-13T10:10:00.000Z",
  settledAt: null,
  ...over,
});

/** An approved candidate with this run's pull request open at the head. */
const approvedWithPullRequest = (
  over: Partial<DeliveryInput> = {},
  pr: Partial<DeliveryPullRequest> = {},
): DeliveryInput =>
  clean({
    approvals: [approval({ status: "answered", decision: "approve" })],
    pullRequests: [pullRequest({ providerNumber: 7, runId: RUN, ...pr })],
    ...over,
  });

Deno.test("an approved candidate at the reviewed head is ready to merge for someone who may", () => {
  const model = deliveryModel(approvedWithPullRequest());
  assertEquals(model.merge?.state, "ready");
  assertEquals(model.merge?.method, "squash");
  assertEquals(model.now, {
    kind: "mergeReady",
    head: NEW.slice(0, 7),
    number: 7,
    branch: "main",
  });
  assertEquals(model.afterApproval.badge, "readyToMerge");
});

Deno.test("someone who may not merge is told so, and no merge is offered", () => {
  const model = deliveryModel(approvedWithPullRequest({}, { mayMerge: false }));
  assertEquals(model.merge?.state, "noPermission");
  assertEquals(model.now, { kind: "mergeNoPermission" });
});

Deno.test("an attempt whose outcome is unknown outranks everything: nothing to merge, a check to make", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeAttempts: [attempt({ state: "unknown" })],
  }));
  assertEquals(model.merge?.state, "unknown");
  assertEquals(model.now, { kind: "mergeUnknown", head: NEW.slice(0, 7) });
  assertEquals(model.afterApproval.badge, "mergeUnknown");
  // Even a candidate that is not approved never offers a merge, and an unknown
  // outcome still shows: the page must not say "merged" or "ready".
  const unapproved = deliveryModel(clean({
    pullRequests: [pullRequest({ providerNumber: 7, runId: RUN })],
    mergeAttempts: [attempt({ state: "unknown" })],
  }));
  assertEquals(unapproved.merge?.state, "unknown");
});

Deno.test("only the newest attempt counts: an old unknown settled by a later refusal is a refusal", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeAttempts: [
      attempt({ id: "m2", state: "refused" }),
      attempt({ id: "m1", state: "unknown" }),
    ],
  }));
  assertEquals(model.merge?.state, "refused");
  assertEquals(model.now, {
    kind: "mergeRefused",
    head: NEW.slice(0, 7),
    mayMerge: true,
  });
});

Deno.test("a pull request that moved after the approval is not offered to merge", () => {
  const model = deliveryModel(approvedWithPullRequest({}, { headSha: OLD }));
  assertEquals(model.merge?.state, "moved");
  assertEquals(model.now, {
    kind: "mergeMoved",
    approved: NEW.slice(0, 7),
    current: OLD.slice(0, 7),
    tried: false,
  });
  // The results, review and approval were for the older commit, and the page
  // says so: the pull request is now at the commit they do not cover.
  assertEquals(model.headSha, OLD);
  assertEquals(model.outOfDate, true);
  assertEquals(model.pullRequestMoved, true);
  assertEquals(model.afterApproval.badge, "changedAfterApproval");
  assertEquals(model.checks.rows.every((row) => row.olderSha !== null), true);
  assertEquals(model.review?.olderSha, NEW.slice(0, 7));
});

Deno.test("a pull request that moved after a merge was tried says so", () => {
  const model = deliveryModel(approvedWithPullRequest(
    { mergeAttempts: [attempt({ id: "m1", state: "refused" })] },
    { headSha: OLD },
  ));
  assertEquals(model.now, {
    kind: "mergeMoved",
    approved: NEW.slice(0, 7),
    current: OLD.slice(0, 7),
    tried: true,
  });
});

Deno.test("a pull request still at the approved commit leaves the results current", () => {
  const model = deliveryModel(approvedWithPullRequest({}));
  assertEquals(model.headSha, NEW);
  assertEquals(model.outOfDate, false);
  assertEquals(model.pullRequestMoved, false);
  assertEquals(model.checks.rows.every((row) => row.olderSha === null), true);
});

Deno.test("results for an older commit offer no merge and the card keeps saying checking", () => {
  const model = deliveryModel(approvedWithPullRequest({
    checks: [
      check({ id: "c1", checkId: "tests" }),
      check({ id: "c2", checkId: "lint", headSha: OLD }),
    ],
  }));
  assertEquals(model.merge, null);
});

Deno.test("with no explicit approval, nothing is offered to merge", () => {
  const model = deliveryModel(clean({
    pullRequests: [pullRequest({ providerNumber: 7, runId: RUN })],
  }));
  assertEquals(model.merge, null);
  assertEquals(model.now, { kind: "clean" });
});

Deno.test("a merged or closed pull request has nothing to merge", () => {
  for (const status of ["merged", "closed"] as const) {
    const model = deliveryModel(
      approvedWithPullRequest({}, { status, mergedSha: NEW }),
    );
    assertEquals(model.merge, null, status);
  }
});

Deno.test("merging never hides a stop or a paused run, except an unknown outcome which says so", () => {
  const paused = deliveryModel(approvedWithPullRequest({ paused: true }));
  assertEquals(paused.now, { kind: "paused" });
  const pausedUnknown = deliveryModel(approvedWithPullRequest({
    paused: true,
    mergeAttempts: [attempt()],
  }));
  assertEquals(pausedUnknown.now, { kind: "paused" });
  const stopped = deliveryModel(approvedWithPullRequest({
    decisions: [
      decision({ ordinal: 0 }),
      decision({ ordinal: 1, decision: "stop", reason: "review_failed" }),
    ],
  }));
  assertEquals(stopped.now.kind, "stopped");
});

Deno.test("attempts that could not be read offer no merge: an unknown outcome might be hiding", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeUnavailable: true,
  }));
  assertEquals(model.merge, null);
  assertEquals(model.now, { kind: "approved" });
});

// ---- merging through the queue: what Bakery is doing, and why it stopped.

const entry = (over: Partial<DeliveryMergeEntry> = {}): DeliveryMergeEntry => ({
  id: "e1",
  status: "queued",
  blockedReason: null,
  expectedHeadSha: NEW,
  createdAt: "2026-11-13T10:20:00.000Z",
  updatedAt: "2026-11-13T10:21:00.000Z",
  ...over,
});

const blocked = (
  blockedReason: string | null,
  over: Partial<DeliveryMergeEntry> = {},
): DeliveryMergeEntry => entry({ status: "blocked", blockedReason, ...over });

Deno.test("a queued merge names the candidate: head, base, run, rules, review and the newest result of every check", () => {
  const model = deliveryModel(approvedWithPullRequest({
    checks: [
      check({
        id: "c0",
        checkId: "tests",
        createdAt: "2026-11-13T09:00:00.000Z",
      }),
      check({ id: "c1", checkId: "tests" }),
      check({ id: "c2", checkId: "lint" }),
    ],
    reviews: [
      review({ id: "r-old", ordinal: 0, policyDigest: "d".repeat(64) }),
      review({ id: "r-new", ordinal: 1 }),
    ],
  }));
  assertEquals(model.merge?.request, {
    repositoryId: REPOSITORY,
    targetBranch: "main",
    expectedBaseSha: BASE,
    runId: RUN,
    policyDigest: POLICY,
    reviewCycleId: "r-new",
    checkRunIds: ["c1", "c2"],
  });
  assertEquals(model.merge?.targetBranch, "main");
  assertEquals(model.merge?.startable, true);
});

Deno.test("without a check result on the reviewed commit there is nothing a queued merge could name: the card says so, offers no Merge, and the badge stays Approved", () => {
  const model = deliveryModel(approvedWithPullRequest({ checks: [] }));
  assertEquals(model.merge?.state, "noChecks");
  assertEquals(model.merge?.request, null);
  assertEquals(model.merge?.startable, false);
  assertEquals(model.now, { kind: "mergeNoChecks", head: NEW.slice(0, 7) });
  assertEquals(model.afterApproval.badge, "approved");
});

Deno.test("someone who may not merge cannot start one, whatever stopped the last", () => {
  for (const reason of ["not_permitted", "unavailable", "not_merged"]) {
    const model = deliveryModel(approvedWithPullRequest(
      { mergeEntries: [blocked(reason)] },
      { mayMerge: false },
    ));
    assertEquals(model.merge?.startable, false, reason);
  }
});

Deno.test("a queued, checking or merging entry shows as Bakery working, with the step's stage and no button", () => {
  for (const status of ["queued", "validating", "merging"] as const) {
    const model = deliveryModel(approvedWithPullRequest({
      mergeEntries: [entry({ status })],
    }));
    assertEquals(model.merge?.state, "working", status);
    assertEquals(model.merge?.stage, status);
    assertEquals(model.merge?.startable, false, status);
    assertEquals(model.now, { kind: "mergeWorking" }, status);
    assertEquals(model.afterApproval.badge, "merging", status);
  }
});

Deno.test("the working card holds even when the run is no longer clean, but not over a pause", () => {
  const working = approvedWithPullRequest({
    mergeEntries: [entry({ status: "merging" })],
  });
  assertEquals(deliveryModel(working).now, { kind: "mergeWorking" });
  assertEquals(deliveryModel({ ...working, paused: true }).now, {
    kind: "paused",
  });
});

Deno.test("a merging entry whose newest attempt is unknown is the unknown card, not working", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [entry({ status: "merging" })],
    mergeAttempts: [attempt({ state: "unknown" })],
  }));
  assertEquals(model.merge?.state, "unknown");
  assertEquals(model.now, { kind: "mergeUnknown", head: NEW.slice(0, 7) });
  assertEquals(model.afterApproval.badge, "mergeUnknown");
});

Deno.test("a merging entry whose newest attempt is not unknown is still working", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [entry({ status: "merging" })],
    mergeAttempts: [attempt({ state: "refused" })],
  }));
  assertEquals(model.merge?.state, "working");
});

Deno.test("an entry the queue merged on a pull request that still reads open is not offered a second merge", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [entry({ status: "merged" })],
  }));
  assertEquals(model.merge?.state, "working");
  assertEquals(model.merge?.stage, "merging");
});

Deno.test("each reason a merge was stopped gives its own card, and a button only when pressing it can help", () => {
  const expectations: ReadonlyArray<
    readonly [
      string | null,
      Readonly<{
        reason: Extract<NowCard, { kind: "mergeBlocked" }>["reason"];
        mayMerge: boolean;
        startable: boolean;
      }>,
    ]
  > = [
    ["head_moved", { reason: "head_moved", mayMerge: false, startable: false }],
    ["base_moved", { reason: "base_moved", mayMerge: false, startable: false }],
    [
      "evidence_changed",
      { reason: "evidence_changed", mayMerge: false, startable: false },
    ],
    [
      "checks_not_passed",
      { reason: "checks_not_passed", mayMerge: false, startable: false },
    ],
    ["not_open", { reason: "not_open", mayMerge: false, startable: false }],
    [
      "not_permitted",
      { reason: "not_permitted", mayMerge: true, startable: true },
    ],
    ["unavailable", { reason: "unavailable", mayMerge: true, startable: true }],
    // No reason, one the page does not know, and one that means nothing to do.
    [null, { reason: null, mayMerge: false, startable: false }],
    ["from_the_future", { reason: null, mayMerge: false, startable: false }],
    ["already_merged", { reason: null, mayMerge: false, startable: false }],
  ];
  for (const [reason, expected] of expectations) {
    const model = deliveryModel(approvedWithPullRequest({
      mergeEntries: [blocked(reason)],
    }));
    assertEquals(model.merge?.state, "blocked", String(reason));
    assertEquals(model.merge?.startable, expected.startable, String(reason));
    assertEquals(model.now, {
      kind: "mergeBlocked",
      reason: expected.reason,
      head: NEW.slice(0, 7),
      branch: "main",
      mayMerge: expected.mayMerge,
    }, String(reason));
    assertEquals(model.afterApproval.badge, "mergeBlocked", String(reason));
  }
});

Deno.test("GitHub's refusal and a merge GitHub did not make are the built cards", () => {
  const refused = deliveryModel(approvedWithPullRequest({
    mergeEntries: [blocked("github_refused")],
  }));
  assertEquals(refused.merge?.state, "refused");
  assertEquals(refused.now, {
    kind: "mergeRefused",
    head: NEW.slice(0, 7),
    mayMerge: true,
  });
  // A stopped queue entry is a merge that did not happen: "Not merged".
  assertEquals(refused.afterApproval.badge, "mergeBlocked");
  const notMerged = deliveryModel(approvedWithPullRequest({
    mergeEntries: [blocked("not_merged")],
  }));
  assertEquals(notMerged.merge?.state, "ready");
  assertEquals(notMerged.merge?.afterNotMerged, true);
  assertEquals(notMerged.merge?.startable, true);
  assertEquals(notMerged.now.kind, "mergeReady");
  assertEquals(notMerged.afterApproval.badge, "readyToMerge");
});

Deno.test("a canceled merge brings the Ready card back", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [entry({ status: "canceled" })],
  }));
  assertEquals(model.merge?.state, "ready");
  assertEquals(model.merge?.canceled, true);
  assertEquals(model.merge?.afterNotMerged, false);
  assertEquals(model.now.kind, "mergeReady");
});

Deno.test("a stopped merge stops showing when the pull request's head changes: the built moved card, tried", () => {
  const model = deliveryModel(approvedWithPullRequest(
    { mergeEntries: [blocked("checks_not_passed")] },
    { headSha: OLD },
  ));
  assertEquals(model.merge?.state, "moved");
  assertEquals(model.now, {
    kind: "mergeMoved",
    approved: NEW.slice(0, 7),
    current: OLD.slice(0, 7),
    tried: true,
  });
});

Deno.test("a stopped merge for an older head does not show against a newer one", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [blocked("checks_not_passed", { expectedHeadSha: OLD })],
  }));
  assertEquals(model.merge?.state, "ready");
  assertEquals(model.now.kind, "mergeReady");
});

Deno.test("a newer entry replaces a stopped one", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [
      blocked("unavailable"),
      entry({
        id: "e2",
        status: "validating",
        createdAt: "2026-11-13T10:30:00.000Z",
        updatedAt: "2026-11-13T10:30:00.000Z",
      }),
    ],
  }));
  assertEquals(model.merge?.state, "working");
  assertEquals(model.merge?.stage, "validating");
  const canceledLater = deliveryModel(approvedWithPullRequest({
    mergeEntries: [
      blocked("unavailable"),
      entry({
        id: "e2",
        status: "canceled",
        createdAt: "2026-11-13T10:30:00.000Z",
        updatedAt: "2026-11-13T10:31:00.000Z",
      }),
    ],
  }));
  assertEquals(canceledLater.merge?.state, "ready");
  assertEquals(canceledLater.merge?.canceled, true);
});

Deno.test("a newer attempt replaces a stopped merge", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [blocked("unavailable")],
    mergeAttempts: [
      attempt({
        id: "m9",
        state: "refused",
        createdAt: "2026-11-13T10:40:00.000Z",
      }),
    ],
  }));
  assertEquals(model.merge?.state, "refused");
  // An attempt the stopped merge itself made does not replace it.
  const own = deliveryModel(approvedWithPullRequest({
    mergeEntries: [blocked("unavailable")],
    mergeAttempts: [
      attempt({
        id: "m9",
        state: "refused",
        createdAt: "2026-11-13T10:20:30.000Z",
      }),
    ],
  }));
  assertEquals(own.merge?.state, "blocked");
});

Deno.test("an older refusal does not show over a newer canceled entry", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [entry({ status: "canceled" })],
    mergeAttempts: [
      attempt({
        state: "refused",
        createdAt: "2026-11-13T10:05:00.000Z",
      }),
    ],
  }));
  assertEquals(model.merge?.state, "ready");
});

Deno.test("a merged or closed pull request shows no stopped merge", () => {
  for (const status of ["merged", "closed"] as const) {
    const model = deliveryModel(approvedWithPullRequest(
      { mergeEntries: [blocked("not_open")] },
      { status, mergedSha: NEW },
    ));
    assertEquals(model.merge, null, status);
  }
});

Deno.test("queued merges that could not be read offer no merge, like unreadable attempts", () => {
  const model = deliveryModel(approvedWithPullRequest({
    mergeEntries: [],
    mergeUnavailable: true,
  }));
  assertEquals(model.merge, null);
});

Deno.test("a refusal reached only through its attempt, or an attempt newer than its entry, is Not merged too", () => {
  const attemptOnly = deliveryModel(approvedWithPullRequest({
    mergeAttempts: [attempt({ state: "refused" })],
  }));
  assertEquals(attemptOnly.merge?.state, "refused");
  assertEquals(attemptOnly.afterApproval.badge, "mergeBlocked");
  const newerThanEntry = deliveryModel(approvedWithPullRequest({
    mergeEntries: [blocked("github_refused")],
    mergeAttempts: [
      attempt({ state: "refused", createdAt: "2026-11-13T10:40:00.000Z" }),
    ],
  }));
  assertEquals(newerThanEntry.merge?.state, "refused");
  assertEquals(newerThanEntry.afterApproval.badge, "mergeBlocked");
});

Deno.test("the Ready card names the branch the pull request merges into", () => {
  const model = deliveryModel(
    approvedWithPullRequest({}, { targetBranch: "release/1.0" }),
  );
  assertEquals(model.now.kind, "mergeReady");
  assertEquals(
    model.now.kind === "mergeReady" ? model.now.branch : null,
    "release/1.0",
  );
});

Deno.test("a check row carries its reason, whether it is a rule, and where its output is", () => {
  const model = deliveryModel(input({
    revisionHeadSha: NEW,
    checks: [
      check({
        id: "c1",
        checkId: "tests",
        result: "failed",
        reason: "exit_nonzero",
        exitCode: 2,
        kind: "command",
        evidenceVersionId: "v-out",
      }),
      check({
        id: "c2",
        checkId: "title",
        result: "failed",
        reason: "rule_violation",
        kind: "title",
        evidenceVersionId: null,
      }),
      check({ id: "c3", checkId: "lint" }),
    ],
  }));
  const row = (name: string) =>
    model.checks.rows.find((entry) => entry.name === name)!;
  assertEquals(
    [row("tests").reason, row("tests").rule, row("tests").evidenceVersionId],
    ["exit_nonzero", false, "v-out"],
  );
  assertEquals(
    [row("title").reason, row("title").rule, row("title").evidenceVersionId],
    ["rule_violation", true, null],
  );
  assertEquals(
    [row("lint").reason, row("lint").rule],
    [null, false],
    "nothing is shown that the server did not report",
  );
});

Deno.test("what Bakery tried: every repair, newest first, with what it was asked to fix", () => {
  const model = deliveryModel(input({
    revisionHeadSha: NEW,
    checks: [
      check({ id: "c1", checkId: "tests", checkName: "Unit tests" }),
      check({ id: "c2", checkId: "lint", checkName: "Lint" }),
    ],
    decisions: [
      decision({
        ordinal: 0,
        decision: "repair",
        reason: "repair_selected",
        headSha: OLD,
        failedChecks: [{ checkId: "tests" }, { checkId: "lint" }],
        blockingFingerprints: ["f1"],
        limits: { maxRepairCycles: 3, maxLoopDurationMs: 1_800_000 },
      }),
      decision({
        ordinal: 1,
        decision: "repair",
        reason: "repair_selected",
        headSha: NEW,
        failedChecks: [{ checkId: "tests" }],
        limits: { maxRepairCycles: 3, maxLoopDurationMs: 1_800_000 },
      }),
    ],
  }));
  const fixing = model.fixing!;
  assertEquals(fixing.tries, [
    {
      n: 2,
      running: true,
      checkNames: ["Unit tests"],
      blocking: 0,
      sha: "91d0aa3",
    },
    {
      n: 1,
      running: false,
      checkNames: ["Unit tests", "Lint"],
      blocking: 1,
      sha: "4be19c2",
    },
  ]);
  assertEquals(fixing.limits, { max: 3, durationMs: 1_800_000 });
});

Deno.test("a try whose check is not in the list is named by its id, and a missing time bound is null", () => {
  const model = deliveryModel(input({
    revisionHeadSha: NEW,
    decisions: [decision({
      ordinal: 0,
      decision: "repair",
      reason: "repair_selected",
      failedChecks: [{ checkId: "gone" }],
    })],
  }));
  assertEquals(model.fixing!.tries[0].checkNames, ["gone"]);
  assertEquals(model.fixing!.limits.durationMs, null);
});

Deno.test("a review accepted anyway shows who, when and why, from the server's record", () => {
  const accepted = deliveryModel(input({
    revisionHeadSha: NEW,
    reviews: [review({
      status: "changes_requested",
      blockingCount: 1,
      findingCount: 1,
      acceptedBy: "p1",
      acceptedByName: "Ana Ruiz",
      acceptedAt: "2026-11-14T09:00:00.000Z",
      acceptReason: "The finding is about generated code.",
    })],
  }));
  assertEquals(accepted.review!.accepted, {
    at: "2026-11-14T09:00:00.000Z",
    reason: "The finding is about generated code.",
    by: "Ana Ruiz",
  });
  assertEquals(
    deliveryModel(input({
      revisionHeadSha: NEW,
      reviews: [
        review({ acceptedBy: null, acceptedAt: null, acceptReason: null }),
      ],
    })).review!.accepted,
    null,
  );
});

Deno.test("a run stopped at its repeat limit asks for more tries, even with nothing else to show", () => {
  const nothing: DeliveryInput = {
    runId: "r",
    checks: [],
    reviews: [],
    findings: [],
    decisions: [],
    approvals: [],
    approvalsUnavailable: false,
    revisionHeadSha: null,
    baseSha: null,
    pullRequests: [],
    mergeAttempts: [],
    mergeEntries: [],
    mergeUnavailable: false,
    paused: false,
  };
  const stopped = deliveryModel({
    ...nothing,
    limitStop: { iterations: 3, allowed: 3, max: 5 },
  });
  assertEquals(stopped.visible, true);
  assertEquals(stopped.now, {
    kind: "limit",
    tried: 3,
    allowed: 3,
    max: 5,
    room: 2,
    blocking: 0,
    merged: false,
  });
  const full = deliveryModel({
    ...nothing,
    limitStop: { iterations: 5, allowed: 5, max: 5 },
  });
  assertEquals(full.visible, false);
  assert(full.now.kind !== "limit");
});
