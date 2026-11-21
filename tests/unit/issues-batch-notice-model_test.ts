import { assertEquals } from "@std/assert";
import { createTranslator } from "@bakery/i18n";
import type { BatchResponse } from "../../apps/web/src/api/client.ts";
import {
  type BatchNotice,
  issuesInBatch,
  liveBatches,
  noticesFor,
} from "../../apps/web/src/pages/issues/batch-notice-model.ts";

/**
 * #58 slice 2b: what the Issues page says about batches, with design-ux's
 * rulings (every live batch, wording and tone by state). Each row of the
 * design's tables is a case here.
 */

const REPO_A = "0195f000-0000-7000-8000-0000000000a1";
const REPO_B = "0195f000-0000-7000-8000-0000000000b2";
const ticket = (n: number) =>
  `0195f000-0000-7000-8000-${String(n).padStart(12, "0")}`;

type IssueSeed = {
  number: number | null;
  state: "started" | "merged" | "failed" | "cancelled" | "passed_over";
};

function batch(
  seed: {
    id?: string;
    repositoryId?: string;
    state?: BatchResponse["state"];
    issuesDone?: number;
    maxIssues?: number;
    waitingOn?: "approval" | "question";
    issues?: IssueSeed[];
  } = {},
): BatchResponse {
  return {
    id: seed.id ?? "0195f000-0000-7000-8000-0000000000c1",
    repositoryId: seed.repositoryId ?? REPO_A,
    state: seed.state ?? "running",
    issuesDone: seed.issuesDone ?? 0,
    maxIssues: seed.maxIssues ?? 5,
    waitingOn: seed.waitingOn === undefined ? null : {
      kind: seed.waitingOn,
      questionId: ticket(1),
      taskId: ticket(2),
      since: "2026-11-21T10:00:00.000Z",
    },
    issues: (seed.issues ?? []).map((issue, index) => ({
      id: ticket(100 + index),
      position: index + 1,
      externalTicketId: ticket(issue.number ?? 0),
      issueNumber: issue.number === null ? null : String(issue.number),
      issueTitle: null,
      state: issue.state,
    })),
  } as unknown as BatchResponse;
}

const AT_WORK: IssueSeed[] = [
  { number: 412, state: "merged" },
  { number: 409, state: "started" },
];

const t = createTranslator({ locale: "en", surface: "test" });

/** The sentence the notice reads as, as the component asks for it. */
function say(notice: BatchNotice, repository: string | null = null): string {
  const where = repository === null ? "none" : "named";
  return notice.state === "waiting"
    ? t("issues.batch.noticeWaiting" as never, {
      where,
      repository: repository ?? "",
      done: notice.done,
      max: notice.max,
    })
    : t("issues.batch.notice" as never, {
      batch: notice.state,
      where,
      repository: repository ?? "",
      done: notice.done,
      max: notice.max,
      tail: notice.tail,
      number: notice.number,
    });
}

const noticeFor = (seed: Parameters<typeof batch>[0]) =>
  noticesFor([batch(seed)], null)[0]!;

Deno.test("every live batch is spoken of, and a finished or stopped one is not", () => {
  const states = [
    "running",
    "waiting",
    "paused",
    "finishing",
    "stopping",
    "finished",
    "stopped",
  ] as const;
  const kept = liveBatches(states.map((state) => batch({ state })));
  assertEquals(
    kept.map((item) => item.state),
    ["running", "waiting", "paused", "finishing", "stopping"],
  );
});

Deno.test("a running batch names the issue it is working on, and counts merged against the limit", () => {
  const notice = noticeFor({
    issuesDone: 1,
    issues: [...AT_WORK, { number: 418, state: "passed_over" }],
  });
  assertEquals(
    [notice.state, notice.tail, notice.number, notice.done, notice.max],
    ["running", "working", "409", 1, 5],
  );
  assertEquals(
    say(notice),
    "A batch is running: 1 of 5 merged, working on #409.",
  );
  assertEquals(notice.tone, "information");
});

Deno.test("a running batch that waits on a person says for what, in the warning tone", () => {
  const issues: IssueSeed[] = [{ number: 421, state: "started" }];
  const approval = noticeFor({ issues, waitingOn: "approval" });
  assertEquals(
    say(approval),
    "A batch is running: 0 of 5 merged, #421 is waiting for approval.",
  );
  assertEquals(approval.tone, "warning");
  const question = noticeFor({ issues, waitingOn: "question" });
  assertEquals(
    say(question),
    "A batch is running: 0 of 5 merged, #421 is waiting for an answer.",
  );
  assertEquals(question.tone, "warning");
});

Deno.test("only a running batch with no issue started is choosing the next one", () => {
  assertEquals(
    say(
      noticeFor({ issuesDone: 1, issues: [{ number: 412, state: "merged" }] }),
    ),
    "A batch is running: 1 of 5 merged, choosing the next issue.",
  );
  // An issue with no number cannot be named, so the line does not pretend to.
  assertEquals(
    say(noticeFor({ issues: [{ number: null, state: "started" }] })),
    "A batch is running: 0 of 5 merged, choosing the next issue.",
  );
  for (const state of ["paused", "finishing", "stopping"] as const) {
    assertEquals(noticeFor({ state, issues: [] }).tail, "none");
  }
});

Deno.test("a batch that asks before the next issue says so, in the warning tone", () => {
  const notice = noticeFor({
    state: "waiting",
    issuesDone: 2,
    issues: [{ number: 412, state: "merged" }],
  });
  assertEquals(
    say(notice),
    "A batch is waiting: 2 of 5 merged. It asks before starting the next issue.",
  );
  assertEquals(notice.tone, "warning");
});

Deno.test("a paused, finishing or stopping batch says its state, and the issue it is still on", () => {
  for (const state of ["paused", "finishing", "stopping"] as const) {
    const withIssue = noticeFor({ state, issuesDone: 1, issues: AT_WORK });
    assertEquals(
      say(withIssue),
      `A batch is ${state}: 1 of 5 merged, working on #409.`,
    );
    assertEquals(withIssue.tone, "information");
    const without = noticeFor({ state, issuesDone: 1, issues: [AT_WORK[0]!] });
    assertEquals(say(without), `A batch is ${state}: 1 of 5 merged.`);
  }
});

Deno.test("the repository is named after the state word, and in the Open button, only when the list shows more than one", () => {
  assertEquals(
    say(noticeFor({ issuesDone: 1, issues: AT_WORK }), "acme/web"),
    "A batch is running in acme/web: 1 of 5 merged, working on #409.",
  );
  assertEquals(
    say(noticeFor({ state: "waiting", issuesDone: 1 }), "acme/web"),
    "A batch is waiting in acme/web: 1 of 5 merged. It asks before starting the next issue.",
  );
  assertEquals(
    t("issues.batch.openNamed" as never, {
      named: "yes",
      repository: "acme/web",
    }),
    "Open the batch in acme/web",
  );
  assertEquals(
    t("issues.batch.openNamed" as never, { named: "no", repository: "" }),
    "Open the batch",
  );
});

Deno.test("with a repository chosen only its batch is shown; with none, every live batch", () => {
  const a = batch({
    id: "0195f000-0000-7000-8000-0000000000c1",
    repositoryId: REPO_A,
  });
  const b = batch({
    id: "0195f000-0000-7000-8000-0000000000c2",
    repositoryId: REPO_B,
    state: "paused",
  });
  const done = batch({
    id: "0195f000-0000-7000-8000-0000000000c3",
    repositoryId: REPO_A,
    state: "finished",
  });
  assertEquals(noticesFor([a, b, done], null).map((n) => n.batchId), [
    a.id,
    b.id,
  ]);
  assertEquals(noticesFor([a, b, done], REPO_B).map((n) => n.batchId), [b.id]);
  assertEquals(noticesFor([done], null), []);
});

Deno.test("an issue is in the batch when a live batch is working on it or has merged it, in any live state", () => {
  const issues: IssueSeed[] = [
    { number: 412, state: "merged" },
    { number: 409, state: "started" },
    { number: 421, state: "failed" },
    { number: 422, state: "cancelled" },
    { number: 418, state: "passed_over" },
  ];
  for (
    const state of [
      "running",
      "waiting",
      "paused",
      "finishing",
      "stopping",
    ] as const
  ) {
    assertEquals(
      [...issuesInBatch([batch({ state, issues })])].sort(),
      [ticket(409), ticket(412)].sort(),
    );
  }
});

Deno.test("an issue of a batch that has ended is not marked", () => {
  const issues: IssueSeed[] = [{ number: 412, state: "merged" }];
  assertEquals(
    issuesInBatch([
      batch({ state: "finished", issues }),
      batch({ state: "stopped", issues }),
    ]).size,
    0,
  );
});
