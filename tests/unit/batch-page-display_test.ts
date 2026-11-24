import { assertEquals } from "@std/assert";
import type {
  BatchIssueResponse,
  BatchResponse,
  BatchStartableResponse,
} from "../../apps/web/src/api/client.ts";
import {
  type BannerFacts,
  bannerFor,
  currentIssue,
  finishReasonKey,
  formatBatchTime,
  headerButtons,
  isDirty,
  isLive,
  issueBadgeFor,
  meter,
  meters,
  parseSpend,
  phrase,
  planValues,
  smallestSpend,
  START_DEFAULTS,
  startableView,
  startBody,
  stateBadgeFor,
  stopChoices,
  tableIssues,
  timeAgo,
  validateStart,
  type WaitingFacts,
  waitingNames,
  waitingView,
  whyItEnded,
} from "../../apps/web/src/pages/batches/batch-display.ts";
import {
  controlRefusal,
  createRefusal,
  createRefusalPlace,
} from "../../apps/web/src/pages/batches/batch-refusal.ts";

const issue = (
  position: number,
  state: BatchIssueResponse["state"],
  id = `issue-${position}`,
): BatchIssueResponse =>
  ({
    id,
    position,
    externalTicketId: `ticket-${position}`,
    state,
    reason: state === "passed_over" ? "predecessor_open" : null,
    ticketRequestId: null,
    costUsd: "0",
    startedAt: null,
    mergedAt: null,
  }) as BatchIssueResponse;

const batch = (overrides: Record<string, unknown> = {}): BatchResponse =>
  ({
    id: "b-1",
    repositoryId: "r-1",
    presetId: "fixed-coding",
    startedBy: "u-1",
    maxIssues: 5,
    maxHours: 8,
    maxSpendUsd: "40.0000",
    continueMode: "carry_on",
    state: "running",
    pauseReason: null,
    pausedBy: null,
    pausedAt: null,
    finishReason: null,
    finishedAt: null,
    stoppedBy: null,
    stopCancelledCurrent: false,
    startedAt: "2026-11-20T09:12:00Z",
    issuesDone: 0,
    elapsedSeconds: 0,
    spentUsd: "0",
    waitingOn: null,
    issues: [],
    createdAt: "2026-11-20T09:12:00Z",
    updatedAt: "2026-11-20T09:12:00Z",
    version: 1,
    ...overrides,
  }) as BatchResponse;

const facts: BannerFacts = {
  workflow: "Fixed coding",
  repository: "acme/web",
  currentNumber: "421",
  lastNumber: "421",
  who: "Ana Ruiz",
  when: "09:12",
  spent: "$22.40",
  limit: "$40",
  waiting: null,
};

const working = [
  issue(1, "merged"),
  issue(2, "merged"),
  issue(3, "merged"),
  issue(4, "started"),
  issue(5, "passed_over"),
];

Deno.test("a batch is live until it has finished or been stopped", () => {
  for (
    const state of [
      "running",
      "waiting",
      "paused",
      "finishing",
      "stopping",
    ] as const
  ) {
    assertEquals(isLive(state), true, state);
  }
  assertEquals(isLive("finished"), false);
  assertEquals(isLive("stopped"), false);
});

Deno.test("the issues table numbers worked issues in order and puts passed-over rows last without a number", () => {
  const rows = tableIssues(batch({
    issues: [issue(1, "merged"), issue(2, "passed_over"), issue(3, "started")],
  }));
  assertEquals(rows.numbered.map((r) => [r.row.id, r.position]), [
    ["issue-1", 1],
    ["issue-3", 2],
  ]);
  assertEquals(rows.passedOver.map((r) => r.id), ["issue-2"]);
  assertEquals(currentIssue(batch({ issues: working }))?.position, 4);
});

Deno.test("each state has the header buttons the design lists, and a cancel in progress has none", () => {
  const buttons = (state: BatchResponse["state"], extra = {}) =>
    headerButtons(batch({ state, ...extra }));
  assertEquals(buttons("running"), ["pause", "stop"]);
  assertEquals(buttons("waiting"), ["pause", "stop"]);
  assertEquals(buttons("paused"), ["stop"]);
  assertEquals(buttons("finishing"), ["stop"]);
  assertEquals(buttons("stopping"), ["cancelNow"]);
  assertEquals(buttons("stopping", { stopCancelledCurrent: true }), []);
  assertEquals(buttons("finished"), []);
  assertEquals(buttons("stopped"), []);
});

Deno.test("a running batch with an issue started names it and its place; with none it is choosing", () => {
  const started = bannerFor(batch({ issues: working }), facts);
  assertEquals(started.title, {
    key: "batches.banner.working.title",
    params: { number: "421", ordinal: 4, max: 5 },
  });
  assertEquals(started.actions, ["openTask"]);
  assertEquals(started.body, { key: "batches.banner.working.body" });
  const choosing = bannerFor(
    batch({ issues: [issue(1, "merged")], issuesDone: 1 }),
    facts,
  );
  assertEquals(choosing.title.key, "batches.banner.choosing.title");
  assertEquals(choosing.actions, []);
});

Deno.test("a waiting batch offers Finish here and Start the next issue", () => {
  const banner = bannerFor(
    batch({ state: "waiting", issues: [issue(1, "merged")], issuesDone: 1 }),
    { ...facts, lastNumber: "412" },
  );
  assertEquals(banner.title, {
    key: "batches.banner.waiting.title",
    params: { number: "412" },
  });
  assertEquals(banner.actions, ["finishHere", "startNext"]);
});

Deno.test("a paused batch says who paused it and whether the issue is still running or merged", () => {
  const byPerson = { state: "paused", pauseReason: "paused_by_person" };
  const running = bannerFor(batch({ ...byPerson, issues: working }), facts);
  assertEquals(running.title.key, "batches.banner.pausedByPerson.title");
  assertEquals(running.body.key, "batches.banner.pausedByPerson.running");
  assertEquals(running.actions, ["openTask", "resume"]);
  const merged = bannerFor(
    batch({ ...byPerson, issues: [issue(1, "merged")], issuesDone: 1 }),
    { ...facts, currentNumber: null, lastNumber: "412" },
  );
  assertEquals(merged.body, {
    key: "batches.banner.pausedByPerson.merged",
    params: { number: "412" },
  });
  assertEquals(merged.actions, ["resume"]);
  assertEquals(
    bannerFor(batch(byPerson), {
      ...facts,
      currentNumber: null,
      lastNumber: null,
    }).body.key,
    "batches.banner.pausedByPerson.nothing",
  );
});

Deno.test("a batch whose workflow can no longer start says which workflow and where, and offers no way to resume", () => {
  const banner = bannerFor(
    batch({ state: "paused", pauseReason: "workflow_cannot_start" }),
    facts,
  );
  assertEquals(banner.title, {
    key: "batches.banner.pausedWorkflow.title",
    params: { workflow: "Fixed coding", repository: "acme/web" },
  });
  assertEquals(banner.body.key, "batches.banner.pausedWorkflow.body");
  assertEquals(banner.actions, []);
});

Deno.test("a batch paused because the server cannot start work says so, and any other pause is plain", () => {
  const noStart = bannerFor(
    batch({ state: "paused", pauseReason: "starting_not_available" }),
    facts,
  );
  assertEquals(noStart.title.key, "batches.banner.pausedNoStart.title");
  assertEquals(noStart.actions, ["resume"]);
  const other = bannerFor(
    batch({ state: "paused", pauseReason: "something_new" }),
    facts,
  );
  assertEquals(other.title.key, "batches.banner.paused.title");
  assertEquals(other.actions, ["resume"]);
});

Deno.test("a finishing batch names the limit it reached and keeps only Open task", () => {
  const banner = bannerFor(
    batch({
      state: "finishing",
      finishReason: "spend_exhausted",
      issues: working,
    }),
    facts,
  );
  assertEquals(banner.title, {
    key: "batches.banner.finishing.title",
    params: { reason: phrase("batches.limit.spend"), number: "421", max: 5 },
  });
  assertEquals(banner.actions, ["openTask"]);
});

Deno.test("stopping after the current issue and cancelling it are different banners", () => {
  const after = bannerFor(batch({ state: "stopping", issues: working }), facts);
  assertEquals(after.title.key, "batches.banner.stopping.title");
  const cancelling = bannerFor(
    batch({ state: "stopping", stopCancelledCurrent: true, issues: working }),
    facts,
  );
  assertEquals(cancelling.title.key, "batches.banner.cancelling.title");
  assertEquals(cancelling.actions, ["openTask"]);
});

Deno.test("a finished batch gives its reason, adds the spend sentence only when over, and offers another batch", () => {
  const within = bannerFor(
    batch({
      state: "finished",
      finishReason: "issues_reached",
      issuesDone: 5,
      spentUsd: "30",
    }),
    facts,
  );
  assertEquals(within.title.key, "batches.banner.finished.title");
  assertEquals(
    within.title.params?.reason,
    phrase("batches.finish.issuesReached"),
  );
  assertEquals(within.body.key, "batches.banner.finished.body");
  assertEquals(within.actions, ["startAnother"]);
  const over = bannerFor(
    batch({
      state: "finished",
      finishReason: "spend_exhausted",
      spentUsd: "43.5",
    }),
    facts,
  );
  assertEquals(over.body.key, "batches.banner.finished.bodyOver");
  const atLimit = bannerFor(
    batch({
      state: "finished",
      finishReason: "spend_exhausted",
      spentUsd: "40",
    }),
    facts,
  );
  assertEquals(atLimit.body.key, "batches.banner.finished.body");
  const unknown = bannerFor(
    batch({ state: "finished", finishReason: "anything_else" }),
    facts,
  );
  assertEquals(unknown.title.key, "batches.banner.finished.titleBare");
});

Deno.test("a stopped batch says whether the current issue was cancelled or finished first", () => {
  assertEquals(
    bannerFor(batch({ state: "stopped", stopCancelledCurrent: true }), facts)
      .body.key,
    "batches.banner.stopped.cancelled",
  );
  const finishedFirst = bannerFor(batch({ state: "stopped" }), facts);
  assertEquals(finishedFirst.body.key, "batches.banner.stopped.finishedFirst");
  assertEquals(finishedFirst.actions, ["startAnother"]);
});

Deno.test("every finish reason the design lists has a phrase and an unknown one has none", () => {
  for (
    const reason of [
      "issues_reached",
      "time_exhausted",
      "spend_exhausted",
      "nothing_eligible",
      "issue_failed",
      "issue_cancelled",
      "authority_lost",
      "finished_by_person",
    ]
  ) {
    assertEquals(typeof finishReasonKey(reason), "string", reason);
  }
  assertEquals(finishReasonKey("who_knows"), null);
  assertEquals(finishReasonKey(null), null);
});

Deno.test("the list's Why it ended is muted for a live batch and the reason for a finished one", () => {
  assertEquals(
    whyItEnded(batch({ state: "running" }))?.key,
    "batches.why.stillGoing",
  );
  assertEquals(
    whyItEnded(batch({ state: "waiting" }))?.key,
    "batches.why.asks",
  );
  assertEquals(
    whyItEnded(batch({ state: "finished", finishReason: "time_exhausted" }))
      ?.key,
    "batches.finish.timeExhausted",
  );
  assertEquals(
    whyItEnded(batch({ state: "finished", finishReason: "unknown" })),
    null,
  );
});

Deno.test("a meter turns to warning from 90% and reports how far over the limit it is", () => {
  assertEquals(meter(89, 100).state, "ok");
  assertEquals(meter(90, 100).state, "warning");
  assertEquals(meter(100, 100).over, null);
  assertEquals(meter(143.5, 100).over, 43.5);
  const m = meters(
    batch({ issuesDone: 3, elapsedSeconds: 3 * 3600, spentUsd: "43.50" }),
  );
  assertEquals(m.issues.state, "ok");
  assertEquals(m.time.limit, 8 * 3600);
  assertEquals(m.spend.over, 3.5);
});

Deno.test("the Stop dialog offers a choice only while an issue is running", () => {
  assertEquals(stopChoices(batch({ issues: working })), "choice");
  assertEquals(
    stopChoices(batch({ issues: [issue(1, "merged")] })),
    "nothingRunning",
  );
});

Deno.test("the start form begins with five issues, eight hours and no spend or choice", () => {
  assertEquals(START_DEFAULTS.maxIssues, "5");
  assertEquals(START_DEFAULTS.maxHours, "8");
  assertEquals(START_DEFAULTS.maxSpend, "");
  assertEquals(START_DEFAULTS.continueMode, "");
  assertEquals(START_DEFAULTS.presetId, "");
  assertEquals(Object.keys(validateStart(START_DEFAULTS)).sort(), [
    "continueMode",
    "maxSpend",
    "presetId",
    "repositoryId",
  ]);
});

Deno.test("each limit is refused outside its range, at its edges", () => {
  const ok = {
    ...START_DEFAULTS,
    repositoryId: "r-1",
    presetId: "fixed-coding",
    maxSpend: "40",
    continueMode: "carry_on" as const,
  };
  assertEquals(validateStart(ok), {});
  const errs = (patch: Record<string, string>) =>
    Object.keys(validateStart({ ...ok, ...patch }));
  assertEquals(errs({ maxIssues: "0" }), ["maxIssues"]);
  assertEquals(errs({ maxIssues: "21" }), ["maxIssues"]);
  assertEquals(errs({ maxIssues: "20" }), []);
  assertEquals(errs({ maxIssues: "2.5" }), ["maxIssues"]);
  assertEquals(errs({ maxHours: "0" }), ["maxHours"]);
  assertEquals(errs({ maxHours: "25" }), ["maxHours"]);
  assertEquals(errs({ maxHours: "24" }), []);
  assertEquals(errs({ maxSpend: "0" }), ["maxSpend"]);
  assertEquals(errs({ maxSpend: "4000.01" }), ["maxSpend"]);
  assertEquals(errs({ maxSpend: "4000" }), []);
  assertEquals(errs({ maxSpend: "" }), ["maxSpend"]);
  assertEquals(errs({ maxSpend: "abc" }), ["maxSpend"]);
  assertEquals(errs({ presetId: "" }), ["presetId"]);
  assertEquals(
    validateStart({ ...ok, presetId: "" }).presetId,
    "batches.start.error.workflowRequired",
  );
});

Deno.test("the amount may carry a dollar sign and thousands commas and is sent with two decimals", () => {
  assertEquals(parseSpend("$1,250.5"), 1250.5);
  assertEquals(parseSpend("40"), 40);
  assertEquals(parseSpend("0.001"), null);
  assertEquals(
    startBody({
      ...START_DEFAULTS,
      repositoryId: "r-1",
      presetId: "fixed-coding-reviewed",
      maxSpend: "$40",
      continueMode: "ask_first",
    }),
    {
      repositoryId: "r-1",
      presetId: "fixed-coding-reviewed",
      maxIssues: 5,
      maxHours: 8,
      maxSpendUsd: "40.00",
      continueMode: "ask_first",
    },
  );
  assertEquals(startBody(START_DEFAULTS), null);
});

Deno.test("leaving is only asked about when something was changed", () => {
  assertEquals(isDirty(START_DEFAULTS, "", ""), false);
  assertEquals(
    isDirty({ ...START_DEFAULTS, repositoryId: "r-1" }, "r-1", ""),
    false,
  );
  assertEquals(
    isDirty({ ...START_DEFAULTS, repositoryId: "r-1" }, "", ""),
    true,
  );
  assertEquals(isDirty({ ...START_DEFAULTS, maxHours: "9" }, "", ""), true);
  assertEquals(
    isDirty({ ...START_DEFAULTS, continueMode: "carry_on" }, "", ""),
    true,
  );
});

Deno.test("a workflow the repository set is not a change, and a different choice is", () => {
  const form = {
    ...START_DEFAULTS,
    repositoryId: "r-1",
    presetId: "fixed-coding",
  };
  assertEquals(isDirty(form, "r-1", "fixed-coding"), false);
  assertEquals(isDirty(form, "r-1", ""), true);
  assertEquals(
    isDirty(
      { ...form, presetId: "fixed-coding-reviewed" },
      "r-1",
      "fixed-coding",
    ),
    true,
  );
});

Deno.test("the plan values mark what is not yet given: no repository is null, the rest an ellipsis", () => {
  const empty = planValues(START_DEFAULTS, null, "en");
  assertEquals(empty.repository, null);
  assertEquals(empty.spend, "…");
  assertEquals(empty.issues, "5");
  const full = planValues(
    {
      ...START_DEFAULTS,
      repositoryId: "r",
      maxSpend: "40",
      continueMode: "carry_on",
    },
    "acme/storefront",
    "en",
  );
  assertEquals(full.spend, "$40");
  assertEquals(full.repository, "acme/storefront");
});

const problem = (fields: Record<string, unknown>) => ({
  kind: "problem" as const,
  problem: { status: 409, code: "STATE_CONFLICT", ...fields },
});

Deno.test("a refused start is told apart by the rule the server names", () => {
  assertEquals(
    createRefusal(problem({ reason: "batch_already_running" })),
    "alreadyRunning",
  );
  assertEquals(
    createRefusal(problem({ reason: "repository_not_taking_issues" })),
    "notTaking",
  );
  // A repository that is gone is a 422: its code is in `issueCodes`, not `reason`.
  assertEquals(
    createRefusal(problem({
      status: 422,
      code: "UNPROCESSABLE",
      issueCodes: ["repository_not_found"],
    })),
    "notFound",
  );
  assertEquals(
    createRefusal(problem({ status: 403, code: "AUTH_FORBIDDEN" })),
    "notAllowed",
  );
  assertEquals(createRefusal(problem({ reason: "something_new" })), "failed");
  assertEquals(createRefusal({ kind: "network" }), "failed");
  assertEquals(createRefusal(new Error("boom")), "failed");
});

Deno.test("each start problem is shown under the Repository field or in a notice above the buttons", () => {
  assertEquals(createRefusalPlace("notTaking"), "repository");
  assertEquals(createRefusalPlace("notFound"), "repository");
  assertEquals(createRefusalPlace("alreadyRunning"), "notice");
  assertEquals(createRefusalPlace("notAllowed"), "notice");
  assertEquals(createRefusalPlace("failed"), "notice");
});

Deno.test("a changed batch, a refusal and a missing batch are different problems after an action", () => {
  assertEquals(controlRefusal(problem({})), "conflict");
  assertEquals(
    controlRefusal(problem({ status: 403, code: "AUTH_FORBIDDEN" })),
    "notAllowed",
  );
  assertEquals(
    controlRefusal(problem({ status: 404, code: "RESOURCE_NOT_FOUND" })),
    "gone",
  );
  assertEquals(
    controlRefusal(problem({ status: 500, code: "INTERNAL" })),
    "failed",
  );
  assertEquals(controlRefusal({ kind: "network" }), "failed");
});

Deno.test("a batch time is shown in the zone it is given, not the machine's", () => {
  const at = "2026-11-20T09:12:00Z";
  // Newer ICU puts a narrow no-break space before AM and PM; the words are what matter.
  const shown = (zone: string) =>
    formatBatchTime(at, "en", zone).replaceAll("\u202f", " ");
  assertEquals(shown("UTC"), "Nov 20, 9:12 AM");
  assertEquals(shown("Pacific/Auckland"), "Nov 20, 10:12 PM");
  assertEquals(shown("America/Los_Angeles"), "Nov 20, 1:12 AM");
  // A zone that moves the date moves the date.
  assertEquals(shown("Pacific/Kiritimati"), "Nov 20, 11:12 PM");
  assertEquals(
    formatBatchTime("2026-11-20T23:30:00Z", "en", "Asia/Tokyo").replaceAll(
      "\u202f",
      " ",
    ),
    "Nov 21, 8:30 AM",
  );
});

const startableIssue = (number: number, checkedAt: string) => ({
  externalTicketId: `ticket-${number}`,
  number: String(number),
  title: `Issue ${number}`,
  url: null,
  checkedAt,
});

const startable = (
  numbers: number[],
  patch: Partial<BatchStartableResponse> = {},
): BatchStartableResponse => ({
  items: numbers.map((number, index) =>
    startableIssue(number, `2026-11-21T10:0${index}:00Z`)
  ),
  nextCursor: null,
  smallestSpendUsd: "12.5000",
  ...patch,
});

Deno.test("the start list shows the first five, says when more can start and dates itself by the oldest check", () => {
  const five = startableView(startable([409, 412, 415, 418, 421]));
  assertEquals(five.issues.map((item) => item.number), [
    "409",
    "412",
    "415",
    "418",
    "421",
  ]);
  assertEquals(five.more, false);
  assertEquals(five.checkedAt, "2026-11-21T10:00:00Z");
  // A next cursor, or more rows than are shown, both mean more can start.
  assertEquals(
    startableView(startable([409], { nextCursor: "c1" })).more,
    true,
  );
  const six = startableView(startable([1, 2, 3, 4, 5, 6]));
  assertEquals(six.issues.length, 5);
  assertEquals(six.more, true);
  const none = startableView(startable([]));
  assertEquals(none.issues, []);
  assertEquals(none.checkedAt, null);
  // The oldest check wins, whatever order the rows come in.
  const mixed = startable([1, 2]);
  mixed.items[0]!.checkedAt = "2026-11-21T12:00:00Z";
  assertEquals(startableView(mixed).checkedAt, "2026-11-21T10:01:00Z");
});

Deno.test("the smallest spend is a number of dollars, or null while unknown and when no work can start", () => {
  assertEquals(smallestSpend(undefined), null);
  assertEquals(smallestSpend(startable([], { smallestSpendUsd: null })), null);
  assertEquals(smallestSpend(startable([])), 12.5);
});

Deno.test("an amount below the smallest is a problem under Spend, and the smallest itself is fine", () => {
  const ok = {
    ...START_DEFAULTS,
    repositoryId: "r-1",
    presetId: "fixed-coding",
    maxSpend: "12.50",
    continueMode: "carry_on" as const,
  };
  assertEquals(validateStart(ok, 12.5), {});
  assertEquals(validateStart({ ...ok, maxSpend: "12.49" }, 12.5), {
    maxSpend: "batches.start.error.maxSpendLow",
  });
  // With no smallest known, only the fixed bounds apply.
  assertEquals(validateStart({ ...ok, maxSpend: "0.01" }, null), {});
  assertEquals(validateStart({ ...ok, maxSpend: "0" }, 12.5), {
    maxSpend: "batches.start.error.maxSpend",
  });
});

Deno.test("a server refusal of a spend that is too low is told apart and shown under Spend", () => {
  const refused = createRefusal(problem({
    status: 422,
    code: "UNPROCESSABLE",
    issueCodes: ["max_spend_below_smallest"],
  }));
  assertEquals(refused, "spendLow");
  assertEquals(createRefusalPlace(refused), "spend");
});

Deno.test("when the stored checks were made is said in the person's language, to the nearest unit", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  assertEquals(timeAgo("2026-11-21T11:48:00Z", now, "en"), "12 minutes ago");
  assertEquals(timeAgo("2026-11-21T09:00:00Z", now, "en"), "3 hours ago");
  assertEquals(timeAgo("2026-11-19T12:00:00Z", now, "en"), "2 days ago");
  assertEquals(timeAgo("2026-11-21T11:59:50Z", now, "en"), "this minute");
  assertEquals(timeAgo("2026-11-21T11:59:00Z", now, "en"), "1 minute ago");
});

// ---- waiting for a person (UX revision 3, slice 3b) ----

const ana = { principalId: "u-ana", displayName: "Ana Ruiz" };
const ben = { principalId: "u-ben", displayName: "Ben Okafor" };
const cho = { principalId: "u-cho", displayName: "Chidi Eze" };
const dee = { principalId: "u-dee", displayName: "Dee Park" };

const waitingOn = (kind: "question" | "approval", askedOf = [ana, ben]) => ({
  kind,
  questionId: "q-1",
  taskId: "task-9",
  since: "2026-11-21T18:00:00Z",
  askedOf,
});

const waitingBatch = (
  kind: "question" | "approval",
  askedOf = [ana, ben],
  state: BatchResponse["state"] = "running",
) => batch({ state, issues: working, waitingOn: waitingOn(kind, askedOf) });

const waitingFacts = (
  b: BatchResponse,
  reader: string | null,
): WaitingFacts => {
  const view = waitingView(b, reader)!;
  return { view, ago: "5 minutes ago", names: waitingNames(view, "you", "en") };
};

Deno.test("only a batch that is working, paused, finishing or stopping can wait on a person", () => {
  for (const state of ["running", "paused", "finishing", "stopping"] as const) {
    assertEquals(
      waitingView(waitingBatch("approval", [ana], state), "u-ana")?.taskId,
      "task-9",
      state,
    );
  }
  for (const state of ["waiting", "finished", "stopped"] as const) {
    assertEquals(
      waitingView(waitingBatch("approval", [ana], state), "u-ana"),
      null,
      state,
    );
  }
  assertEquals(waitingView(batch({ issues: working }), "u-ana"), null);
});

Deno.test("the reader is put first and named at most with two others; a reader who was not asked sees up to three names", () => {
  const you = waitingView(
    waitingBatch("approval", [ben, ana, cho]),
    "u-ana",
  )!;
  assertEquals([you.forYou, you.others], [true, ["Ben Okafor", "Chidi Eze"]]);
  assertEquals(
    waitingNames(you, "you", "en"),
    "you, Ben Okafor, and Chidi Eze",
  );
  const alone = waitingView(waitingBatch("approval", [ana]), "u-ana")!;
  assertEquals(waitingNames(alone, "you", "en"), "you");
  const pair = waitingView(waitingBatch("approval", [ana, ben]), "u-ana")!;
  assertEquals(waitingNames(pair, "you", "en"), "you and Ben Okafor");
  const other = waitingView(
    waitingBatch("approval", [ben, cho, dee]),
    "u-ana",
  )!;
  assertEquals([other.forYou, other.others.length], [false, 3]);
  const nobody = waitingView(waitingBatch("question", []), "u-ana")!;
  assertEquals([nobody.forYou, waitingNames(nobody, "you", "en")], [false, ""]);
  assertEquals(
    waitingView(waitingBatch("approval", [ana]), null)?.forYou,
    false,
  );
});

Deno.test("a working batch waiting for an approval names the issue, who was asked and what happens next", () => {
  const b = waitingBatch("approval");
  const mine = bannerFor(b, { ...facts, waiting: waitingFacts(b, "u-ana") });
  assertEquals(mine.tone, "warning");
  assertEquals(mine.title, {
    key: "batches.banner.waitingOn.title.approvalYou",
    params: { number: "421" },
  });
  assertEquals(mine.body, {
    key: "batches.banner.waitingOn.body.named",
    params: {
      time: "5 minutes ago",
      names: "you and Ben Okafor",
      outcome: phrase("batches.banner.waitingOn.approved"),
    },
  });
  assertEquals(mine.actions, ["openTask"]);
  assertEquals(mine.extra, undefined);
  const theirs = bannerFor(b, { ...facts, waiting: waitingFacts(b, "u-zed") });
  assertEquals(theirs.title.key, "batches.banner.waitingOn.title.approval");
});

Deno.test("a question has its own title and says it carries on when answered; no names say anyone on the task can answer", () => {
  const b = waitingBatch("question", []);
  const banner = bannerFor(b, { ...facts, waiting: waitingFacts(b, "u-ana") });
  assertEquals(banner.title, {
    key: "batches.banner.waitingOn.title.question",
    params: { number: "421" },
  });
  assertEquals(banner.body.key, "batches.banner.waitingOn.body.open");
  assertEquals(
    banner.body.params?.outcome,
    phrase("batches.banner.waitingOn.answered"),
  );
});

Deno.test("a paused, finishing or stopping batch keeps its banner and adds one sentence about the wait", () => {
  for (const state of ["paused", "finishing", "stopping"] as const) {
    const plain = bannerFor(batch({ state, issues: working }), facts);
    const b = waitingBatch("approval", [ana], state);
    const banner = bannerFor(b, {
      ...facts,
      waiting: waitingFacts(b, "u-ana"),
    });
    assertEquals(
      { ...banner, extra: undefined },
      { ...plain, extra: undefined },
      state,
    );
    assertEquals(banner.extra, {
      key: "batches.banner.waitingOn.extra.approvalYou",
      params: { number: "421" },
    }, state);
  }
  const q = waitingBatch("question", [ana], "paused");
  assertEquals(
    bannerFor(q, { ...facts, waiting: waitingFacts(q, "u-ana") }).extra?.key,
    "batches.banner.waitingOn.extra.question",
  );
  const other = waitingBatch("approval", [ben], "paused");
  assertEquals(
    bannerFor(other, { ...facts, waiting: waitingFacts(other, "u-ana") }).extra
      ?.key,
    "batches.banner.waitingOn.extra.approval",
  );
});

Deno.test("the badge says who the batch waits for while it is working and is the batch's own state otherwise", () => {
  const running = waitingBatch("approval", [ana]);
  assertEquals(stateBadgeFor(running, waitingView(running, "u-ana")), {
    key: "batches.badge.waitingForYou",
    tone: "warning",
  });
  assertEquals(
    stateBadgeFor(running, waitingView(running, "u-zed")).key,
    "batches.badge.waitingForSomeone",
  );
  const paused = waitingBatch("approval", [ana], "paused");
  assertEquals(
    stateBadgeFor(paused, waitingView(paused, "u-ana")).key,
    "batches.state.paused",
  );
  const plain = batch({ issues: working });
  assertEquals(stateBadgeFor(plain, null), {
    key: "batches.state.running",
    tone: "information",
  });
});

Deno.test("the issue being worked on reads Waiting in the warning tone only while the batch waits", () => {
  assertEquals(issueBadgeFor("started", true), {
    key: "batches.issueState.waiting",
    tone: "warning",
  });
  assertEquals(
    issueBadgeFor("started", false).key,
    "batches.issueState.working",
  );
  assertEquals(issueBadgeFor("merged", true).key, "batches.issueState.merged");
});

Deno.test("the list says which issue a waiting batch is on, and keeps the muted line until the number is known", () => {
  const b = waitingBatch("approval", [ana]);
  assertEquals(whyItEnded(b, "421"), {
    key: "batches.why.waitingOn",
    params: { number: "421" },
  });
  assertEquals(whyItEnded(b)?.key, "batches.why.stillGoing");
  assertEquals(
    whyItEnded(batch({ issues: working }), "421")?.key,
    "batches.why.stillGoing",
  );
});

Deno.test("with four people asked and the reader first, the names are the reader and two others", () => {
  const view = waitingView(
    waitingBatch("approval", [ana, ben, cho, dee]),
    "u-ana",
  )!;
  assertEquals([view.forYou, view.others], [true, ["Ben Okafor", "Chidi Eze"]]);
  assertEquals(
    waitingNames(view, "you", "en"),
    "you, Ben Okafor, and Chidi Eze",
  );
  // A reader who was not asked sees three of the four.
  const other = waitingView(
    waitingBatch("approval", [ben, cho, dee, ana]),
    "u-zed",
  )!;
  assertEquals(
    other.others,
    ["Ben Okafor", "Chidi Eze", "Dee Park", "Ana Ruiz"].slice(0, 3),
  );
});

Deno.test("the list says Waiting on #n only while the batch is working; a paused, finishing or stopping one keeps its muted line", () => {
  for (const state of ["paused", "finishing", "stopping"] as const) {
    assertEquals(
      whyItEnded(waitingBatch("approval", [ana], state), "421")?.key,
      "batches.why.stillGoing",
      state,
    );
  }
});

Deno.test("the current row reads Waiting in every state that waits for a person, and Working once nothing does", () => {
  for (const state of ["running", "paused", "finishing", "stopping"] as const) {
    const b = waitingBatch("approval", [ana], state);
    assertEquals(
      issueBadgeFor("started", waitingView(b, "u-ana") !== null).key,
      "batches.issueState.waiting",
      state,
    );
  }
  // The other states have no issue being worked on, so no waiting is read.
  for (const state of ["waiting", "finished", "stopped"] as const) {
    const b = waitingBatch("approval", [ana], state);
    assertEquals(
      issueBadgeFor("started", waitingView(b, "u-ana") !== null).key,
      "batches.issueState.working",
      state,
    );
  }
});
