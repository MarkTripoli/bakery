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
  ghRunner,
  type Job,
  jobsFromPages,
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
  trigger: "scheduled" as const,
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
      "scheduled",
      at,
    ),
    redBody(
      failingJobs([job("a / y", "failure"), job("w / z", "failure")]),
      url,
      "scheduled",
      at,
    ),
  );
});

/**
 * The pagination contract, tested at the seam that parses pages.
 *
 * A run with more than 100 jobs makes `gh api --paginate` emit one JSON
 * document per page; concatenated, that is not parseable as one document, so
 * the whole read fails and the signal reports could-not-read and leaves the
 * issue untouched - a silent stop for exactly the busy CI the signal exists to
 * watch. `--slurp` makes gh emit an array of pages instead, and this seam is
 * where that shape is insisted on. It is tested apart from the command that
 * spawns `gh` because the unit lane grants no `--allow-run=gh`; widening the
 * lane to fit a test is the thing we do not do.
 */
const PAGE_ONE = {
  total_count: 2,
  jobs: [{ name: "fast / unit", status: "completed", conclusion: "success" }],
};
const PAGE_TWO = {
  total_count: 2,
  jobs: [{ name: "fast / rails", status: "completed", conclusion: "failure" }],
};

Deno.test("every page of jobs is read, not only the first", () => {
  const jobs = jobsFromPages([PAGE_ONE, PAGE_TWO]);
  assertEquals(jobs.map((job) => job.name), [
    "fast / unit",
    "fast / rails",
  ]);
});

Deno.test("concatenated pages are refused, not read as one page", () => {
  // The shape `--paginate` produces without `--slurp`: two documents, parsed as
  // one value. If this were accepted the second page's failure would be dropped
  // and a red run reported as green.
  let threw = false;
  try {
    // A single object where an array of pages is required: the parse must not
    // quietly take the first page and stop.
    jobsFromPages(PAGE_ONE);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("an empty page list is no jobs, not a failure", () => {
  assertEquals(jobsFromPages([]), []);
});

Deno.test("the body says which kind of run failed", () => {
  // The same code path serves a schedule and a maintainer dispatch. A body that
  // calls a dispatch "the scheduled run" records something that did not happen,
  // and the tracking issue outlives the run that wrote it.
  const at = new Date("2026-11-18T05:23:00Z");
  const url = "https://github.com/o/r/actions/runs/123";
  const failing = failingJobs([job("a / y", "failure")]);
  assertEquals(
    redBody(failing, url, "scheduled", at).split("\n")[0],
    "The scheduled run on 2026-11-18T05:23:00Z failed.",
  );
  assertEquals(
    redBody(failing, url, "dispatched", at).split("\n")[0],
    "The dispatched run on 2026-11-18T05:23:00Z failed.",
  );
});

Deno.test("a green dispatched run closes the issue as a dispatched run", async () => {
  const { gh, calls } = recordingGh({ jobs: [], openIssues: [42] });
  const outcome = await runNightlySignal(gh, {
    ...options,
    trigger: "dispatched",
  });
  assertEquals(outcome.kind, "closed");
  const close = calls.find((call) => call.op === "close");
  assert(
    String(close?.comment).includes("dispatched run went green"),
    `expected the close comment to name a dispatched run, got ${close?.comment}`,
  );
});

Deno.test("the real runner never hands `gh api` a --repo flag it rejects", async () => {
  // A stand-in `gh` that refuses `api ... --repo` the way the real one does
  // ("unknown flag: --repo") and logs every argv it is given.
  const dir = await Deno.makeTempDir({ prefix: "nightly-signal-gh-" });
  const log = `${dir}/argv.log`;
  const script = `#!/bin/sh
echo "$*" >> "${log}"
if [ "$1" = "api" ]; then
  for a in "$@"; do
    if [ "$a" = "--repo" ]; then echo "unknown flag: --repo" >&2; exit 1; fi
  done
  echo '[{"jobs":[{"name":"x","conclusion":"success"}]}]'
elif [ "$1 $2" = "issue list" ]; then
  echo '[]'
elif [ "$1 $2" = "issue close" ]; then
  :
else
  echo "https://github.com/owner/repo/issues/7"
fi
`;
  await Deno.writeTextFile(`${dir}/gh`, script);
  await Deno.chmod(`${dir}/gh`, 0o755);
  const path = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${dir}:${path}`);
  try {
    const gh = ghRunner("owner/repo", "token");
    const jobs = await gh.listJobs("42");
    assertEquals(jobs.length, 1);
    await gh.findOpenIssues(SIGNAL_TITLE);
    const calls = (await Deno.readTextFile(log)).trim().split("\n");
    assert(calls[0].startsWith("api repos/owner/repo/actions/runs/42/jobs"));
    assert(!calls[0].includes("--repo"));
    assert(calls[1].startsWith("issue list"));
    assert(calls[1].endsWith("--repo owner/repo"));
    // The writes: create, edit and comment print an issue URL, close prints
    // nothing. None of them answers in JSON, and none may throw once gh succeeded.
    await gh.createIssue("title", "body");
    await gh.updateIssue(7, "body");
    await gh.commentOnIssue(7, "still red");
    await gh.closeIssue(7, "green");
    const writes = (await Deno.readTextFile(log)).trim().split("\n").slice(2);
    assertEquals(
      writes.map((call) => call.split(" ").slice(0, 2).join(" ")),
      ["issue create", "issue edit", "issue comment", "issue close"],
    );
    for (const call of writes) assert(call.endsWith("--repo owner/repo"));
  } finally {
    Deno.env.set("PATH", path);
    await Deno.remove(dir, { recursive: true });
  }
});
