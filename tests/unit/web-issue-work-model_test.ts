import { assertEquals } from "@std/assert";
import {
  currentRequest,
  noteView,
  pausedBanner,
  progressNext,
  progressReason,
  questionRow,
  startedBy,
  stoppableRunId,
  stopsBeforeStart,
  waitsOnAnswer,
  workFinished,
} from "../../apps/web/src/pages/issues/work-model.ts";

/**
 * #69 web: how the issue page reads the server's start request and the link's
 * note health. Each table row of the UX design is one case here.
 */

const ME = "0195f000-0000-7000-8000-00000000000a";
const OTHER = "0195f000-0000-7000-8000-00000000000b";

Deno.test("every progress value has the design's one next step", () => {
  assertEquals(progressNext("pending"), "none");
  assertEquals(progressNext("waiting"), "none");
  assertEquals(progressNext("suspended"), "none");
  assertEquals(progressNext("admitted"), "openTask");
  assertEquals(progressNext("active"), "openTask");
  assertEquals(progressNext("completed"), "openTask");
  assertEquals(progressNext("failed"), "openTask");
  // Start work is the status card's button, so the row has no next step.
  assertEquals(progressNext("canceled"), "none");
  assertEquals(progressNext("rejected"), "none");
});

Deno.test("only waiting, paused and not-started lines quote the reason", () => {
  const code = "predecessor_open";
  for (const progress of ["waiting", "suspended", "rejected"] as const) {
    assertEquals(
      progressReason({ progress, dispositionReasonCode: code }),
      code,
    );
  }
  for (
    const progress of [
      "pending",
      "admitted",
      "active",
      "completed",
      "failed",
      "canceled",
    ] as const
  ) {
    assertEquals(
      progressReason({ progress, dispositionReasonCode: "run_failed" }),
      null,
    );
  }
});

Deno.test("who started the work: the viewer, a teammate, or a label", () => {
  const manual = {
    origin: "manual",
    requestedByPrincipalId: ME,
    triggerLabelName: null,
  } as const;
  assertEquals(startedBy(manual, ME), { kind: "you" });
  assertEquals(startedBy(manual, OTHER), { kind: "member", name: null });
  assertEquals(startedBy(manual, null), { kind: "member", name: null });
  // A name the memberships read knows is used; one it does not know is not.
  const names = (id: string) =>
    id === ME ? "Mark" : id === OTHER ? "Ana Reyes" : null;
  assertEquals(startedBy(manual, ME, names), { kind: "you" });
  assertEquals(
    startedBy({ ...manual, requestedByPrincipalId: ME }, OTHER, names),
    {
      kind: "member",
      name: "Mark",
    },
  );
  assertEquals(
    startedBy(
      {
        ...manual,
        requestedByPrincipalId: "0195f000-0000-7000-8000-0000000000ff",
      },
      OTHER,
      names,
    ),
    { kind: "member", name: null },
  );
  assertEquals(startedBy({ ...manual, origin: "adoption" }, ME), {
    kind: "youAdopted",
  });
  assertEquals(startedBy({ ...manual, origin: "adoption" }, OTHER), {
    kind: "memberAdopted",
    name: null,
  });
  for (const origin of ["webhook", "poll"] as const) {
    assertEquals(
      startedBy({
        origin,
        requestedByPrincipalId: null,
        triggerLabelName: "bakery",
      }, ME),
      { kind: "label", label: "bakery" },
    );
  }
});

Deno.test("the note's state and the reason a failed one gives", () => {
  assertEquals(
    noteView({ syncHealth: "unknown", lastProblemCode: null }),
    { state: "unknown" },
  );
  assertEquals(
    noteView({ syncHealth: "pending", lastProblemCode: null }),
    { state: "pending" },
  );
  assertEquals(
    noteView({ syncHealth: "healthy", lastProblemCode: null }),
    { state: "healthy" },
  );
  assertEquals(
    noteView({ syncHealth: "healthy", lastProblemCode: "note_recreated" }),
    { state: "recreated" },
  );
  assertEquals(
    noteView({ syncHealth: "failed", lastProblemCode: "auth_forbidden" }),
    { state: "failed", reason: "permission" },
  );
  assertEquals(
    noteView({
      syncHealth: "failed",
      lastProblemCode: "dependency_unavailable",
    }),
    { state: "failed", reason: "unavailable" },
  );
  assertEquals(
    noteView({ syncHealth: "failed", lastProblemCode: "note_post_failed" }),
    { state: "failed", reason: "refused" },
  );
  assertEquals(
    noteView({ syncHealth: "failed", lastProblemCode: null }),
    { state: "failed", reason: "refused" },
  );
});

Deno.test("a paused request earns its banner, an unpaused one none", () => {
  const suspended = { progress: "suspended" } as const;
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "edited_after_setup" }),
    "editedAfterSetup",
  );
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "label_removed" }),
    "labelRemoved",
  );
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "hold_label_added" }),
    "onHold",
  );
  assertEquals(
    pausedBanner({ ...suspended, pausedReason: "dependency_unreadable" }),
    "dependencyUnreadable",
  );
  assertEquals(pausedBanner({ ...suspended, pausedReason: null }), null);
  // A request that resumed keeps its pause cause on record but is not paused.
  assertEquals(
    pausedBanner({ progress: "active", pausedReason: "label_removed" }),
    null,
  );
});

Deno.test("the page speaks about the newest request", () => {
  assertEquals(currentRequest([]), null);
  const newest = { id: "a" } as never;
  assertEquals(currentRequest([newest, { id: "b" } as never]), newest);
});

/** #61 slice 1: the question row, read from a task's served questions. */
const asked = (
  status: "open" | "answered" | "expired" | "withdrawn" | "superseded",
  createdAt: string,
  prompt = "Which database should this use?",
  kind: "question" | "approval" = "question",
) => ({ kind, status, prompt, createdAt });

Deno.test("no questions, or only answered ones, show no row", () => {
  assertEquals(questionRow([]), null);
  assertEquals(
    questionRow([asked("answered", "2026-01-01T10:00:00.000Z")]),
    null,
  );
});

Deno.test("an open question shows its first two lines and when it was asked", () => {
  assertEquals(
    questionRow([
      asked(
        "open",
        "2026-01-01T10:00:00.000Z",
        "Which database?\n\n  Postgres or SQLite.  \nThird line.",
      ),
    ]),
    {
      kind: "open",
      count: 1,
      lines: ["Which database?", "Postgres or SQLite."],
      askedAt: "2026-01-01T10:00:00.000Z",
    },
  );
});

Deno.test("several open questions are counted and the oldest is shown", () => {
  const row = questionRow([
    asked("open", "2026-01-01T12:00:00.000Z", "Newer"),
    asked("open", "2026-01-01T09:00:00.000Z", "Oldest"),
    asked("open", "2026-01-01T11:00:00.000Z", "Middle"),
    asked("answered", "2026-01-01T08:00:00.000Z", "Done"),
  ]);
  assertEquals(row, {
    kind: "open",
    count: 3,
    lines: ["Oldest"],
    askedAt: "2026-01-01T09:00:00.000Z",
  });
});

Deno.test("an approval is a decision on the task page, not a question here", () => {
  assertEquals(
    questionRow([
      asked(
        "open",
        "2026-01-01T10:00:00.000Z",
        "Approve the plan?",
        "approval",
      ),
    ]),
    null,
  );
});

Deno.test("an expired question shows only while it is the newest", () => {
  assertEquals(
    questionRow([asked("expired", "2026-01-01T10:00:00.000Z")]),
    { kind: "expired" },
  );
  // An answer came after the expiry: nothing to say any more.
  assertEquals(
    questionRow([
      asked("expired", "2026-01-01T10:00:00.000Z"),
      asked("answered", "2026-01-01T11:00:00.000Z"),
    ]),
    null,
  );
  // Another question is open: that one is shown, not the expiry.
  assertEquals(
    questionRow([
      asked("expired", "2026-01-01T10:00:00.000Z"),
      asked("open", "2026-01-01T11:00:00.000Z", "Again?"),
    ])?.kind,
    "open",
  );
});

Deno.test("the badge says Needs an answer only while work is under way and a question is open", () => {
  const open = questionRow([asked("open", "2026-01-01T10:00:00.000Z")]);
  assertEquals(waitsOnAnswer("active", open), true);
  assertEquals(waitsOnAnswer("admitted", open), true);
  // A paused, finished or stopped request keeps its own word.
  for (
    const progress of [
      "pending",
      "waiting",
      "suspended",
      "completed",
      "failed",
      "canceled",
      "rejected",
    ] as const
  ) assertEquals(waitsOnAnswer(progress, open), false);
  assertEquals(waitsOnAnswer("active", null), false);
  assertEquals(
    waitsOnAnswer(
      "active",
      questionRow([asked("expired", "2026-01-01T10:00:00.000Z")]),
    ),
    false,
  );
});

Deno.test("a run can be stopped only while it is starting, working or paused", () => {
  const RUN = "0195f000-0000-7000-8000-0000000000c1";
  for (const progress of ["admitted", "active", "suspended"] as const) {
    assertEquals(stoppableRunId({ progress, workflowRunId: RUN }), RUN);
  }
  for (
    const progress of [
      "pending",
      "waiting",
      "completed",
      "failed",
      "canceled",
      "rejected",
    ] as const
  ) {
    assertEquals(stoppableRunId({ progress, workflowRunId: RUN }), null);
  }
});

Deno.test("a request with no run has nothing to stop yet", () => {
  for (const progress of ["admitted", "active", "suspended"] as const) {
    assertEquals(stoppableRunId({ progress, workflowRunId: null }), null);
  }
});

Deno.test("work started from a label with no run yet says how to stop it on GitHub", () => {
  for (const origin of ["webhook", "poll"] as const) {
    for (
      const progress of ["pending", "waiting", "admitted", "suspended"] as const
    ) {
      assertEquals(
        stopsBeforeStart({ origin, progress, workflowRunId: null }),
        true,
      );
    }
  }
});

Deno.test("the label sentence is not shown for a person's start, a started run or finished work", () => {
  const RUN = "0195f000-0000-7000-8000-0000000000c1";
  for (const origin of ["manual", "adoption"] as const) {
    assertEquals(
      stopsBeforeStart({ origin, progress: "waiting", workflowRunId: null }),
      false,
    );
  }
  assertEquals(
    stopsBeforeStart({
      origin: "webhook",
      progress: "active",
      workflowRunId: RUN,
    }),
    false,
  );
  for (
    const progress of ["completed", "failed", "canceled", "rejected"] as const
  ) {
    assertEquals(
      stopsBeforeStart({ origin: "poll", progress, workflowRunId: null }),
      false,
    );
  }
});

Deno.test("work is finished once it completed, failed, was stopped or was not started", () => {
  for (
    const progress of ["completed", "failed", "canceled", "rejected"] as const
  ) assertEquals(workFinished(progress), true);
  for (
    const progress of [
      "pending",
      "waiting",
      "admitted",
      "active",
      "suspended",
    ] as const
  ) assertEquals(workFinished(progress), false);
});
