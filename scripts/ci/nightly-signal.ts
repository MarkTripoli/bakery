/**
 * The nightly red signal: turn a scheduled red run into a tracking issue, and
 * close that issue when a scheduled run goes green.
 *
 * The decision lives here rather than in the workflow file so it can be tested.
 * The workflow job supplies the environment, the real `gh`, and nothing else.
 * Everything this module reasons over - which jobs failed, whether an issue is
 * already open - arrives through `GhRunner`, so a test hands it a job list and
 * a recorder and asserts what the signal decided. That matters because the
 * alternative is what shipped first: inline shell that could only be exercised
 * by waiting for a scheduled run that happened to be red.
 *
 * Three constraints, each deliberate:
 *
 *   * One open issue, found by its stable title. A second red updates it and
 *     never duplicates, so a week of red is one issue, not seven.
 *   * A failure to read state exits without writing. An unreadable issue list
 *     must never be read as "no issue exists" - that would open a duplicate
 *     every red night.
 *   * A signal failure never turns a green nightly red. Every path returns an
 *     outcome instead of throwing, and the caller reports it without failing.
 */

/** The issue title. Stable and undated: a dated title cannot be found again. */
export const SIGNAL_TITLE = "nightly red: scheduled CI";

/** The outcome of one signal run, for the log and for tests to assert on. */
export type SignalOutcome =
  | { readonly kind: "created"; readonly failing: readonly string[] }
  | { readonly kind: "updated"; readonly issue: number }
  | { readonly kind: "closed"; readonly issue: number }
  | { readonly kind: "nothing-to-do" }
  | {
    readonly kind: "could-not-read";
    readonly what: string;
    readonly why: string;
  };

/** The only thing the signal needs from the outside world. */
export type GhRunner = {
  /** The run's jobs, as the API returns them. */
  readonly listJobs: (runId: string) => Promise<readonly Job[]>;
  /** Numbers of open issues carrying the signal title. */
  readonly findOpenIssues: (
    title: string,
  ) => Promise<readonly number[]>;
  readonly createIssue: (title: string, body: string) => Promise<void>;
  readonly updateIssue: (number: number, body: string) => Promise<void>;
  readonly commentOnIssue: (number: number, body: string) => Promise<void>;
  readonly closeIssue: (number: number, comment: string) => Promise<void>;
};

export type Job = {
  readonly name: string;
  readonly conclusion: string | null;
};

/**
 * A job counts as failing when it neither succeeded nor was skipped. Anything
 * else - failure, cancelled, timed out, action_required, a conclusion that never
 * arrived - is a red the tracking issue must carry. Sorted and unique so two
 * runs that fail the same way produce a byte-identical body.
 */
export function failingJobs(jobs: readonly Job[]): readonly string[] {
  const failing = jobs
    .filter((job) =>
      job.conclusion !== "success" && job.conclusion !== "skipped"
    )
    .map((job) => job.name);
  return [...new Set(failing)].sort();
}

/**
 * The issue body: when, which jobs, and the run that said so. Short on purpose -
 * the run link is the evidence, the body points at it.
 */
export function redBody(
  failing: readonly string[],
  runUrl: string,
  trigger: RunTrigger,
  now: Date,
): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return [
    `The ${trigger} run on ${stamp} failed.`,
    "",
    "Failing jobs:",
    ...failing.map((job) => `- \`${job}\``),
    "",
    `Run: ${runUrl}`,
  ].join("\n");
}

/**
 * What to call the run in the issue body.
 *
 * Required and undefaulted, because the same code path serves a scheduled run and
 * a maintainer dispatch, and a body that calls a dispatch "the scheduled run"
 * describes something that did not happen. The caller knows which it is; this
 * module cannot tell by looking, and guessing would put a false sentence in a
 * record that outlives the run.
 */
export type RunTrigger = "scheduled" | "dispatched";

export type SignalOptions = {
  readonly runId: string;
  readonly runUrl: string;
  readonly trigger: RunTrigger;
  readonly now?: Date;
};

/**
 * Decide and apply. Every failure to read state returns `could-not-read` with
 * nothing written; the caller turns that into a log line, not a failed job.
 */
export async function runNightlySignal(
  gh: GhRunner,
  options: SignalOptions,
): Promise<SignalOutcome> {
  const now = options.now ?? new Date();

  let jobs: readonly Job[];
  try {
    jobs = await gh.listJobs(options.runId);
  } catch (error) {
    return {
      kind: "could-not-read",
      what: "the run's jobs",
      why: message(error),
    };
  }

  const failing = failingJobs(jobs);

  let open: readonly number[];
  try {
    open = await gh.findOpenIssues(SIGNAL_TITLE);
  } catch (error) {
    return {
      kind: "could-not-read",
      what: "the open issues",
      why: message(error),
    };
  }
  const existing = open[0];

  if (failing.length > 0) {
    const body = redBody(failing, options.runUrl, options.trigger, now);
    if (existing !== undefined) {
      await gh.updateIssue(existing, body);
      await gh.commentOnIssue(existing, `Still red on ${options.runUrl}`);
      return { kind: "updated", issue: existing };
    }
    await gh.createIssue(SIGNAL_TITLE, body);
    return { kind: "created", failing };
  }

  if (existing !== undefined) {
    await gh.closeIssue(
      existing,
      `The ${options.trigger} run went green: ${options.runUrl}`,
    );
    return { kind: "closed", issue: existing };
  }

  return { kind: "nothing-to-do" };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/**
 * Every job across every page `gh api --paginate --slurp` returned.
 *
 * The parse lives here, apart from the command that produces it, because the
 * unit lane grants no `--allow-run=gh`: a test that spawned `gh` could not run
 * where the signal is tested. The lane's permission is not widened to fit a
 * test, so the decision moves to a seam the lane can reach - and the shape it
 * insists on is the one `--slurp` produces, an array of pages, rather than the
 * concatenated documents `--paginate` emits without it.
 */
export function jobsFromPages(pages: unknown): readonly Job[] {
  if (!Array.isArray(pages)) {
    throw new Error("could not read the run's jobs: not a list of pages");
  }
  return pages.flatMap((page) =>
    (page as { jobs?: readonly Job[] }).jobs ?? []
  );
}

/**
 * The real `gh`, over the API. Kept in this file so it is easy to see the whole
 * surface the signal touches: two reads and four writes, nothing else.
 */
export function ghRunner(repo: string, token: string): GhRunner {
  const api = async (args: readonly string[]): Promise<unknown> => {
    const result = await new Deno.Command("gh", {
      args: [...args, "--repo", repo],
      env: { ...Deno.env.toObject(), GH_TOKEN: token },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!result.success) {
      throw new Error(
        `gh ${args.join(" ")}: ${
          new TextDecoder().decode(result.stderr).trim()
        }`,
      );
    }
    return JSON.parse(new TextDecoder().decode(result.stdout) || "null");
  };

  return {
    listJobs: async (runId) => {
      // `--paginate` alone concatenates one JSON document per page, and parsing
      // that as a single document fails. `--slurp` makes gh emit an array of
      // pages instead, so every job is read no matter how many pages the run
      // takes. Assuming one page would be an assumption about the size of CI
      // rather than a property of the query.
      const pages = await api([
        "api",
        `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`,
        "--paginate",
        "--slurp",
      ]).catch(() => null);
      if (pages === null) throw new Error("could not read the run's jobs");
      return jobsFromPages(pages);
    },
    findOpenIssues: async (title) => {
      const found = await api([
        "issue",
        "list",
        "--state",
        "open",
        "--search",
        `in:title "${title}"`,
        "--json",
        "number,title",
      ]);
      return (found as readonly { number: number; title: string }[])
        .filter((issue) => issue.title === title)
        .map((issue) => issue.number);
    },
    createIssue: async (title, body) => {
      await api(["issue", "create", "--title", title, "--body", body]);
    },
    updateIssue: async (number, body) => {
      await api(["issue", "edit", String(number), "--body", body]);
    },
    commentOnIssue: async (number, body) => {
      await api(["issue", "comment", String(number), "--body", body]);
    },
    closeIssue: async (number, comment) => {
      await api(["issue", "close", String(number), "--comment", comment]);
    },
  };
}

if (import.meta.main) {
  const repo = Deno.env.get("REPO");
  const runId = Deno.env.get("RUN_ID");
  const serverUrl = Deno.env.get("SERVER_URL");
  const token = Deno.env.get("GH_TOKEN");
  const eventName = Deno.env.get("GITHUB_EVENT_NAME");
  if (!repo || !runId || !serverUrl || !token) {
    // A missing variable is a wiring defect in this workflow, not a condition
    // the signal was asked to handle. Exiting 0 would hide it for good: the job
    // is `continue-on-error`, so a green step is never looked at. The annotation
    // makes it visible on the run page, and the non-zero exit lets the job fail
    // without failing the workflow, which is exactly what continue-on-error
    // already means.
    const missing = [
      ["REPO", repo],
      ["RUN_ID", runId],
      ["SERVER_URL", serverUrl],
      ["GH_TOKEN", token],
      ["GITHUB_EVENT_NAME", eventName],
    ].filter(([, value]) => !value).map(([name]) => name).join(", ");
    console.error(
      `::error::nightly signal: ${missing} missing from the workflow environment`,
    );
    Deno.exit(1);
  }
  // The workflow only reaches this step for a schedule or a maintainer
  // dispatch, so anything else is a wiring mistake worth failing on rather than
  // describing as a scheduled run.
  if (eventName !== "schedule" && eventName !== "workflow_dispatch") {
    console.error(
      `::error::nightly signal: unexpected event ${eventName}; this step runs for schedule and workflow_dispatch only`,
    );
    Deno.exit(1);
  }
  const outcome = await runNightlySignal(ghRunner(repo, token), {
    runId,
    runUrl: `${serverUrl}/${repo}/actions/runs/${runId}`,
    trigger: eventName === "schedule" ? "scheduled" : "dispatched",
  });
  if (outcome.kind === "could-not-read") {
    console.error(
      `nightly signal: could not read ${outcome.what} (${outcome.why}); leaving the issue untouched`,
    );
  } else if (outcome.kind === "created") {
    console.log(`nightly signal: created the tracking issue`);
  } else if (outcome.kind === "updated") {
    console.log(`nightly signal: updated issue #${outcome.issue}`);
  } else if (outcome.kind === "closed") {
    console.log(`nightly signal: closed issue #${outcome.issue}`);
  } else {
    console.log("nightly signal: green, nothing to close");
  }
}
