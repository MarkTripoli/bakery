import { assertEquals } from "@std/assert";
import { createTranslator } from "@bakery/i18n";
import {
  MERGE_NOTICE_KEYS,
  MERGE_REFUSAL_ABOVE,
  mergeBlockedCopy,
  mergeNoChecksCopy,
  mergeReadyCopy,
  mergeStepCopy,
  mergeWorkingCopy,
} from "../../apps/web/src/pages/task-delivery/merge-copy.ts";
import { queueFailure } from "../../apps/web/src/pages/task-delivery/merge-refusal.ts";
import type {
  MergeView,
  NowCard,
} from "../../apps/web/src/pages/task-delivery/model.ts";

const t = createTranslator({ locale: "en", surface: "test" });

const view = (over: Partial<MergeView> = {}): MergeView => ({
  state: "ready",
  pullRequestId: "p7",
  providerNumber: 7,
  url: "https://github.com/o/r/pull/7",
  targetBranch: "main",
  stage: null,
  blockedReason: null,
  afterNotMerged: false,
  canceled: false,
  request: null,
  startable: false,
  headSha: "91d0aa3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  approvedSha: null,
  attemptedSha: "91d0aa3bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  method: "squash",
  mayMerge: true,
  ...over,
});

type Blocked = Extract<NowCard, { kind: "mergeBlocked" }>;

const blocked = (
  reason: Blocked["reason"],
  mayMerge = true,
): Blocked => ({
  kind: "mergeBlocked",
  reason,
  head: "91d0aa3",
  branch: "main",
  mayMerge,
});

Deno.test("while Bakery works the card says so, has nothing for the person to do, and no button", () => {
  assertEquals(mergeWorkingCopy(t), {
    title: "Checking before the merge",
    body:
      "Bakery is checking that nothing changed since the review, then it merges. Nothing for you to do.",
    action: null,
  });
});

Deno.test("an approved commit with no check results says so and sends the person to its checks, never offering Merge", () => {
  assertEquals(mergeNoChecksCopy(t, "91d0aa3"), {
    title: "No check results for this commit",
    body:
      "Bakery merges only what was checked, and it has no check results for commit 91d0aa3. Open the pull request to see its checks.",
    action: "openOnGitHub",
  });
});

Deno.test("a stopped merge for a moved head reuses the moved card's title", () => {
  assertEquals(
    mergeBlockedCopy(t, blocked("head_moved")).title,
    t("tasks.delivery.now.mergeMoved.title"),
  );
});

Deno.test("each reason a merge was stopped says what happened, in the design's words", () => {
  const cases: ReadonlyArray<readonly [Blocked["reason"], string, string]> = [
    [
      "head_moved",
      "Not merged: the pull request changed",
      "The pull request changed after the checks ran, and Bakery merges only what was checked. Checks and the review need to pass for the new commit, and it needs approving again, before it can merge.",
    ],
    [
      "base_moved",
      "Not merged: main changed",
      "main got new commits after the checks ran, and Bakery merges only what was checked. Checks and the review need to pass again on top of main.",
    ],
    [
      "evidence_changed",
      "Not merged: the review or the rules changed",
      "What was checked no longer matches. The repository's rules or the review changed after the merge was asked for. Checks and the review need to pass again.",
    ],
    [
      "checks_not_passed",
      "Not merged: a check no longer passes",
      "GitHub reports a required check that has not passed for commit 91d0aa3. Open the pull request to see which one.",
    ],
    [
      "not_open",
      "Not merged: the pull request is closed",
      "It was closed on GitHub before Bakery could merge it. Nothing was merged.",
    ],
    [
      "not_permitted",
      "Not merged: permission was removed",
      "The person who asked for this merge can no longer merge in this repository. Someone who can merge can start it again.",
    ],
    [
      "unavailable",
      "Not merged: Bakery could not finish",
      "Bakery could not reach GitHub after several tries, so it stopped. Nothing was merged.",
    ],
    [
      null,
      "Bakery did not merge this",
      "The merge was stopped and Bakery was not told why. Open the pull request to check it.",
    ],
  ];
  for (const [reason, title, body] of cases) {
    const copy = mergeBlockedCopy(t, blocked(reason));
    assertEquals(copy.title, title, String(reason));
    assertEquals(copy.body, body, String(reason));
  }
});

Deno.test("each stopped merge has one button at most, and only when pressing it can help", () => {
  const actions = (mayMerge: boolean) =>
    Object.fromEntries(
      [
        "head_moved",
        "base_moved",
        "evidence_changed",
        "checks_not_passed",
        "not_open",
        "not_permitted",
        "unavailable",
        null,
      ].map((
        reason,
      ) => [
        String(reason),
        mergeBlockedCopy(t, blocked(reason as Blocked["reason"], mayMerge))
          .action,
      ]),
    );
  assertEquals(actions(true), {
    head_moved: null,
    base_moved: null,
    evidence_changed: null,
    checks_not_passed: "openOnGitHub",
    not_open: "openOnGitHub",
    not_permitted: "mergeAgain",
    unavailable: "mergeAgain",
    null: "openOnGitHub",
  });
  // Merge again is only for a reader who may merge; the rest do not change.
  assertEquals(actions(false), {
    head_moved: null,
    base_moved: null,
    evidence_changed: null,
    checks_not_passed: "openOnGitHub",
    not_open: "openOnGitHub",
    not_permitted: null,
    unavailable: null,
    null: "openOnGitHub",
  });
});

Deno.test("the Merge step says where the queue is, in its own sentence per stage", () => {
  const working = (stage: "queued" | "validating" | "merging") =>
    mergeStepCopy(t, {
      merge: view({ state: "working", stage }),
      pullRequest: { status: "open" },
      mergeCommit: null,
    });
  assertEquals(working("queued"), {
    status: "running",
    summary: "About to check that nothing changed since the review.",
  });
  assertEquals(working("validating"), {
    status: "running",
    summary: "Checking that nothing changed since the review.",
  });
  assertEquals(working("merging"), {
    status: "running",
    summary: "Merging into main.",
  });
});

const stopped = (over: Partial<MergeView>) =>
  mergeStepCopy(t, {
    merge: view({ state: "blocked", ...over }),
    pullRequest: { status: "open" },
    mergeCommit: null,
  });

Deno.test("a stopped merge fails the Merge step: Bakery did not merge, and the short cause", () => {
  const sentences: ReadonlyArray<
    readonly [MergeView["blockedReason"], string]
  > = [
    ["base_moved", "Bakery did not merge. main changed after the checks ran."],
    [
      "evidence_changed",
      "Bakery did not merge. The review or the rules changed.",
    ],
    [
      "checks_not_passed",
      "Bakery did not merge. A required check no longer passes.",
    ],
    ["not_open", "Bakery did not merge. The pull request was closed."],
    ["not_permitted", "Bakery did not merge. Permission was removed."],
    ["unavailable", "Bakery did not merge. It could not reach GitHub."],
    [null, "Bakery did not merge. It was not told why."],
    [
      "head_moved",
      "Bakery did not merge. The pull request no longer matches what was checked.",
    ],
  ];
  for (const [reason, summary] of sentences) {
    assertEquals(
      stopped({ blockedReason: reason }),
      { status: "failed", summary },
      String(reason),
    );
  }
});

Deno.test("a merge GitHub did not make and a canceled merge fail the step with their own sentence", () => {
  assertEquals(
    mergeStepCopy(t, {
      merge: view({ afterNotMerged: true }),
      pullRequest: { status: "open" },
      mergeCommit: null,
    }),
    { status: "failed", summary: "GitHub did not merge it." },
  );
  assertEquals(
    mergeStepCopy(t, {
      merge: view({ canceled: true }),
      pullRequest: { status: "open" },
      mergeCommit: null,
    }),
    { status: "failed", summary: "The merge was canceled." },
  );
});

Deno.test("the Merge step keeps its built sentences: merged, not yet, unknown", () => {
  assertEquals(
    mergeStepCopy(t, {
      merge: null,
      pullRequest: { status: "merged" },
      mergeCommit: "9be04c1dddddddddddddddddddddddddddddddd",
    }),
    {
      status: "done",
      summary: "Merged as 9be04c1, confirmed by GitHub.",
    },
  );
  assertEquals(
    mergeStepCopy(t, {
      merge: null,
      pullRequest: { status: "open" },
      mergeCommit: null,
    }),
    { status: "upcoming", summary: "Not merged yet." },
  );
  assertEquals(
    mergeStepCopy(t, { merge: null, pullRequest: null, mergeCommit: null })
      .status,
    "unknown",
  );
});

Deno.test("each refusal to start a merge has its own notice, naming the branch or the commit", () => {
  const say = (phase: keyof typeof MERGE_NOTICE_KEYS) =>
    t(MERGE_NOTICE_KEYS[phase], { branch: "main", head: "91d0aa3" });
  assertEquals(
    say("inProgress"),
    "Another change is merging into main right now. Nothing was started. Try again in a moment.",
  );
  assertEquals(
    say("conflict"),
    "The pull request changed just now. The latest is shown.",
  );
  assertEquals(say("baseMoved"), "main changed just now. The latest is shown.");
  assertEquals(
    say("notOpen"),
    "This pull request is no longer open. Nothing was merged.",
  );
  assertEquals(
    say("findingsBlocking"),
    "The review has findings that block the merge.",
  );
  assertEquals(
    say("checksNotPassed"),
    "A required check has not passed for commit 91d0aa3.",
  );
  assertEquals(
    say("forbidden"),
    "Someone who can merge in this repository can do it here.",
  );
  assertEquals(
    say("error"),
    "The merge was not started. Nothing changed. Try again.",
  );
  // The refusals that started nothing show above the card.
  assertEquals(
    [...MERGE_REFUSAL_ABOVE].sort(),
    [
      "baseMoved",
      "checksNotPassed",
      "findingsBlocking",
      "inProgress",
      "notOpen",
    ],
  );
});

const problem = (
  status: number,
  code: string,
  reason?: string,
  retryable = false,
) => ({
  kind: "problem",
  problem: {
    status,
    retryable,
    code,
    ...(reason === undefined ? {} : { reason }),
  },
});

Deno.test("a refused merge request is told by its reason", () => {
  const refusals: ReadonlyArray<readonly [number, string, string, string]> = [
    [409, "STATE_CONFLICT", "target_merge_in_progress", "inProgress"],
    [412, "PRECONDITION_FAILED", "head_moved", "conflict"],
    [412, "PRECONDITION_FAILED", "review_evidence_stale", "conflict"],
    [412, "PRECONDITION_FAILED", "check_evidence_stale", "conflict"],
    [412, "PRECONDITION_FAILED", "base_moved", "baseMoved"],
    [409, "STATE_CONFLICT", "pull_request_not_open", "notOpen"],
    [409, "STATE_CONFLICT", "review_findings_blocking", "findingsBlocking"],
    [409, "STATE_CONFLICT", "checks_not_passed", "checksNotPassed"],
    [412, "PRECONDITION_FAILED", "check_runs_missing", "checksNotPassed"],
    // A conflict the page has no words for is the generic notice.
    [409, "STATE_CONFLICT", "something_new", "error"],
    [409, "STATE_CONFLICT", "constructor", "error"],
  ];
  for (const [status, code, reason, phase] of refusals) {
    assertEquals(queueFailure(problem(status, code, reason)), phase, reason);
  }
  assertEquals(queueFailure(problem(409, "STATE_CONFLICT")), "error");
  assertEquals(queueFailure(problem(403, "AUTH_FORBIDDEN")), "forbidden");
  assertEquals(queueFailure(problem(404, "RESOURCE_NOT_FOUND")), "error");
  assertEquals(queueFailure(problem(422, "UNPROCESSABLE")), "error");
});

Deno.test("an answer that never arrived is not a refusal", () => {
  assertEquals(queueFailure({ kind: "network" }), "noAnswer");
  assertEquals(
    queueFailure(problem(503, "UNAVAILABLE", undefined, true)),
    "noAnswer",
  );
  assertEquals(queueFailure(problem(500, "INTERNAL")), "noAnswer");
});

Deno.test("the Ready card says which branch Merge puts the changes into", () => {
  assertEquals(
    mergeReadyCopy(t, {
      kind: "mergeReady",
      head: "91d0aa3",
      number: 482,
      branch: "release/1.0",
    }),
    {
      title: "Ready to merge",
      body:
        "Checks and the review passed for commit 91d0aa3, and it was approved. Merging puts these changes into release/1.0.",
      action: "merge",
    },
  );
});
