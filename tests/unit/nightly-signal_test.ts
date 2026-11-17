/**
 * The nightly red signal decides three things: which jobs count as failing,
 * whether an open tracking issue is updated rather than duplicated, and whether
 * a green run closes it. Those decisions used to be inline shell inside the
 * workflow file, where the only way to exercise them was to wait for a
 * scheduled run that happened to be red - which is exactly why the signal
 * shipped with none of them proven.
 *
 * These tests drive the real decision function through a recording `GhRunner`,
 * so each assertion is about what the signal actually did, not about what it
 * would print.
 */
import { assert, assertEquals } from "@std/assert";
import {
  failingJobs,
  type GhRunner,
  type Job,
  redBody,
  runNightlySignal,
  SIGNAL_TITLE,
} from "../../scripts/ci/nightly-signal.ts";

type Call =
  | { readonly op: "create"; readonly title: string; readonly body: string }
  | { readonly op: "update"; readonly issue: number; readonly body: string }
  | { readonly op: "comment"; readonly issue: number; readonly body: string }
  | { readonly op: "close"; readonly issue: number; readonly comment: string };

/** A `gh` that answers from a fixture and records every write. */
function recordingGh(fixture: {
  readonly jobs?: readonly Job[];
  readonly openIssues?: readonly number[];
  readonly failJobs?: boolean;
  readonly failIssueList?: boolean;
}): { readonly gh: GhRunner; readonly calls: Call[] } {
  const calls: Call[] = [];
  const gh: GhRunner = {
    listJobs: () => {
      if (fixture.failJobs) return Promise.reject(new Error("api down"));
      return Promise.resolve(fixture.jobs ?? []);
    },
    findOpenIssues: () => {
      if (fixture.failIssueList) {
        return Promise.reject(new Error("issue list down"));
      }
      return Promise.resolve(fixture.openIssues ?? []);
    },
    createIssue: (title, body) => {
      calls.push({ op: "create", title, body });
      return Promise.resolve();
    },
    updateIssue: (issue, body) => {
      calls.push({ op: "update", issue, body });
      return Promise.resolve();
    },
    commentOnIssue: (issue, body) => {
      calls.push({ op: "comment", issue, body });
      return Promise.resolve();
    },
    closeIssue: (issue, comment) => {
      calls.push({ op: "close", issue, comment });
      return Promise.resolve();
    },
  };
  return { gh, calls };
}

const options = {
  runId: "123",
  runUrl: "https://github.com/o/r/actions/runs/123",
  now: new Date("2026-11-18T05:23:00Z"),
};

const job = (name: string, conclusion: string | null): Job => ({
  name,
  conclusion,
});

Deno.test("a red run opens one tracking issue naming the failing jobs", async () => {
  const { gh, calls } = recordingGh({
    jobs: [
      job("fast / format", "success"),
      job("full / integration", "failure"),
      job("ui / storybook browser", "cancelled"),
      job("docs / validation", "skipped"),
    ],
  });

  const outcome = await runNightlySignal(gh, options);

  assertEquals(outcome.kind, "created");
  assertEquals(calls.length, 1);
  const created = calls[0];
  assertEquals(created?.op, "create");
  if (created?.op !== "create") throw new Error("unreachable");
  assertEquals(created.title, SIGNAL_TITLE);
  // The issue names the failing jobs and links the run that said so.
  assert(created.body.includes("`full / integration`"), created.body);
  assert(created.body.includes("`ui / storybook browser`"), created.body);
  // A skipped job is not a failure: reporting it would be a lie about the run.
  assert(!created.body.includes("docs / validation"), created.body);
  // A green job is not a failure either, however many there are.
  assert(!created.body.includes("fast / format"), created.body);
  assert(created.body.includes(options.runUrl), created.body);
});

Deno.test("a second red run updates the open issue instead of duplicating it", async () => {
  const { gh, calls } = recordingGh({
    jobs: [job("full / integration", "failure")],
    openIssues: [42],
  });

  const outcome = await runNightlySignal(gh, options);

  assertEquals(outcome.kind, "updated");
  assertEquals(
    calls.some((call) => call.op === "create"),
    false,
    "a second red must not open a second issue",
  );
  const update = calls.find((call) => call.op === "update");
  assertEquals(update?.op === "update" ? update.issue : null, 42);
  // It also says the run is still red, so the issue is not silently stale.
  assert(calls.some((call) => call.op === "comment"));
});

Deno.test("a green run closes the open issue with a link to the green run", async () => {
  const { gh, calls } = recordingGh({
    jobs: [job("fast / format", "success")],
    openIssues: [42],
  });

  const outcome = await runNightlySignal(gh, options);

  assertEquals(outcome.kind, "closed");
  assertEquals(calls.length, 1);
  const closed = calls[0];
  assertEquals(closed?.op, "close");
  if (closed?.op !== "close") throw new Error("unreachable");
  assertEquals(closed.issue, 42);
  assert(closed.comment.includes(options.runUrl), closed.comment);
});

Deno.test("a green run with no open issue writes nothing", async () => {
  const { gh, calls } = recordingGh({
    jobs: [job("fast / format", "success")],
  });

  const outcome = await runNightlySignal(gh, options);

  assertEquals(outcome.kind, "nothing-to-do");
  assertEquals(calls, [], "a green run with nothing open must not write");
});

Deno.test("an unreadable issue list is never read as 'no issue exists'", async () => {
  // The fear this guards: a failed issue list would make the signal believe no
  // issue exists and open a duplicate on every red night.
  const { gh, calls } = recordingGh({
    jobs: [job("full / integration", "failure")],
    failIssueList: true,
  });

  const outcome = await runNightlySignal(gh, options);

  assertEquals(outcome.kind, "could-not-read");
  assertEquals(calls, [], "an unreadable issue list must write nothing");
});

Deno.test("an unreadable job list writes nothing", async () => {
  const { gh, calls } = recordingGh({
    failJobs: true,
    openIssues: [42],
  });

  const outcome = await runNightlySignal(gh, options);

  assertEquals(outcome.kind, "could-not-read");
  // In particular it must not close the issue on the assumption of green.
  assertEquals(calls, []);
});

Deno.test("a conclusion that never arrived counts as failing", async () => {
  // A cancelled or still-running job is not a success. Reading "not success" as
  // "green" would close the tracking issue while CI is actually broken.
  const { gh, calls } = recordingGh({
    jobs: [job("full / integration", null)],
  });

  const outcome = await runNightlySignal(gh, options);

  assertEquals(outcome.kind, "created");
  assert(
    calls.some((call) => call.op === "create" && call.body.includes("full")),
  );
});

Deno.test("the same failing set produces the same body", () => {
  // Two runs that fail the same way must not churn the issue body: a diff that
  // is only reordering makes a reader think something changed.
  const url = "https://github.com/o/r/actions/runs/1";
  const at = new Date("2026-11-18T05:23:00Z");
  // `failingJobs` is the boundary that sorts, so the guarantee is asserted on
  // the function that feeds the body - not on `redBody` itself, which renders
  // whatever order it is handed.
  assertEquals(
    failingJobs([job("w / z", "failure"), job("a / y", "failure")]),
    failingJobs([job("a / y", "failure"), job("w / z", "failure")]),
  );
  assertEquals(
    redBody(
      failingJobs([job("w / z", "failure"), job("a / y", "failure")]),
      url,
      at,
    ),
    redBody(
      failingJobs([job("a / y", "failure"), job("w / z", "failure")]),
      url,
      at,
    ),
  );
});
