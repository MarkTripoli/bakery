import { assertEquals } from "@std/assert";
import {
  type DeliveryCheck,
  type DeliveryDecision,
  type DeliveryFinding,
  type DeliveryInput,
  deliveryModel,
  type DeliveryReview,
  findingTitle,
} from "../../apps/web/src/pages/task-delivery/model.ts";

const OLD = "4be19c2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NEW = "91d0aa3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
  checks: [],
  reviews: [],
  findings: [],
  decisions: [],
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
