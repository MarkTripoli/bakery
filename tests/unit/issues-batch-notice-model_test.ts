import { assertEquals } from "@std/assert";
import { createTranslator } from "@bakery/i18n";
import type { BatchResponse } from "../../apps/web/src/api/client.ts";
import {
  issuesInBatch,
  noticeOf,
  noticesFor,
  runningBatches,
} from "../../apps/web/src/pages/issues/batch-notice-model.ts";

/**
 * #58 slice 2b: what the Issues page says about batches. Each row of the UX
 * design's "Issues page notice" and "In the batch" is a case here.
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

Deno.test("only a running batch is spoken of: paused, waiting, stopping, finishing and ended ones are not", () => {
  const states = [
    "running",
    "waiting",
    "paused",
    "stopping",
    "finishing",
    "finished",
    "stopped",
  ] as const;
  const kept = runningBatches(states.map((state) => batch({ state })));
  assertEquals(kept.map((item) => item.state), ["running"]);
});

Deno.test("the notice names the issue being worked on, and counts merged against the limit", () => {
  const notice = noticeOf(batch({
    issuesDone: 2,
    maxIssues: 5,
    issues: [
      { number: 412, state: "merged" },
      { number: 415, state: "merged" },
      { number: 409, state: "started" },
      { number: 418, state: "passed_over" },
    ],
  }));
  assertEquals(
    [notice.state, notice.number, notice.done, notice.max],
    ["working", "409", 2, 5],
  );
});

Deno.test("a batch that waits on a person says what for, on the issue it is on", () => {
  const issues: IssueSeed[] = [{ number: 421, state: "started" }];
  assertEquals(
    noticeOf(batch({ issues, waitingOn: "approval" })).state,
    "approval",
  );
  assertEquals(
    noticeOf(batch({ issues, waitingOn: "question" })).state,
    "question",
  );
});

Deno.test("a running batch with no issue started is choosing the next one", () => {
  assertEquals(noticeOf(batch({ issues: [] })).state, "choosing");
  // An issue with no number cannot be named, so the line does not pretend to.
  assertEquals(
    noticeOf(batch({ issues: [{ number: null, state: "started" }] })).state,
    "choosing",
  );
  assertEquals(
    noticeOf(batch({
      issues: [{ number: 412, state: "merged" }],
    })).state,
    "choosing",
  );
});

Deno.test("with a repository chosen only its batch is shown; with none, every running batch", () => {
  const a = batch({
    id: "0195f000-0000-7000-8000-0000000000c1",
    repositoryId: REPO_A,
  });
  const b = batch({
    id: "0195f000-0000-7000-8000-0000000000c2",
    repositoryId: REPO_B,
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

Deno.test("an issue is in the batch when a running batch is working on it or has merged it", () => {
  const running = batch({
    issues: [
      { number: 412, state: "merged" },
      { number: 409, state: "started" },
      { number: 421, state: "failed" },
      { number: 422, state: "cancelled" },
      { number: 418, state: "passed_over" },
    ],
  });
  assertEquals(
    [...issuesInBatch([running])].sort(),
    [ticket(409), ticket(412)].sort(),
  );
});

Deno.test("an issue of a batch that is not running is not marked", () => {
  const ended = batch({
    state: "finished",
    issues: [{ number: 412, state: "merged" }],
  });
  const paused = batch({
    state: "paused",
    issues: [{ number: 409, state: "started" }],
  });
  assertEquals(issuesInBatch([ended, paused]).size, 0);
});

const t = createTranslator({ locale: "en", surface: "test" });
const say = (
  state: string,
  repository: string | null = null,
) =>
  t("issues.batch.notice" as never, {
    where: repository === null ? "none" : "named",
    repository: repository ?? "",
    done: 2,
    max: 5,
    state,
    number: "409",
  });

Deno.test("the notice reads as the design words it, for each state", () => {
  assertEquals(
    say("working"),
    "A batch is running: 2 of 5 merged, working on #409.",
  );
  assertEquals(
    say("approval"),
    "A batch is running: 2 of 5 merged, #409 is waiting for approval.",
  );
  assertEquals(
    say("question"),
    "A batch is running: 2 of 5 merged, #409 is waiting for an answer.",
  );
  assertEquals(
    say("choosing"),
    "A batch is running: 2 of 5 merged, choosing the next issue.",
  );
});

Deno.test("the repository is named in the notice, and in the Open button, only when the list shows more than one", () => {
  assertEquals(
    say("working", "acme/web"),
    "A batch is running in acme/web: 2 of 5 merged, working on #409.",
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
