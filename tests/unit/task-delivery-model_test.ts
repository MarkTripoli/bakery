import { assertEquals } from "@std/assert";
import {
  approvalsForRun,
  type DeliveryApproval,
  type DeliveryCheck,
  type DeliveryDecision,
  type DeliveryFinding,
  type DeliveryInput,
  type DeliveryMergeAttempt,
  deliveryModel,
  type DeliveryPullRequest,
  type DeliveryReview,
  findingTitle,
  type ListedApproval,
} from "../../apps/web/src/pages/task-delivery/model.ts";

const OLD = "4be19c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "91d0aa3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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

const input = (over: Partial<DeliveryInput> = {}): DeliveryInput => ({
  runId: RUN,
  checks: [],
  reviews: [],
  findings: [],
  decisions: [],
  approvals: [],
  pullRequests: [],
  mergeAttempts: [],
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
  assertEquals(model.fixing, {
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
  });
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
  assertEquals(stopped("repair_cycles_exhausted"), {
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
  headSha: NEW,
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
