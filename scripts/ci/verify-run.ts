import { parsePolicy, type RequiredChecksPolicy } from "./evaluate.ts";

export type RunSummary = {
  path: string;
  event: string;
  head_sha: string;
  run_attempt: number;
  conclusion: string | null;
  head_repository: { full_name: string };
  // GitHub attaches the pull request reference(s) that triggered the run to
  // the run object itself; unlike a live GET /pulls/{n} call, this is not
  // re-fetched after the run completes, so its `base.sha` may be the base
  // the candidate actually ran against. This field's freshness guarantee is
  // not documented by GitHub [INFERENCE], and the plan deliberately avoided
  // relying on it for PR resolution; `evaluateEvidence`'s own base_sha
  // comparison remains the enforced backstop. Absent or non-matching data
  // is therefore its own explicit refusal (`baseUnrecorded`), not a silent
  // skip — see the `expected.baseAdvanced` / `expected.baseUnrecorded`
  // handling below.
  pull_requests?: readonly { number: number; base: { sha: string } }[];
};

export type JobSummary = {
  name: string;
  conclusion: string | null;
};

export type PullSummary = {
  number: number;
  state: string;
  head: { sha: string; repo: { full_name: string } };
  base: { ref: string; sha: string; repo: { full_name: string } };
  merge_commit_sha: string | null;
};

const headShaPattern = /^[0-9a-f]{40}$/;

const GITHUB_API_ORIGIN = "https://api.github.com";

const normalizeGithubApiPath = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value, GITHUB_API_ORIGIN);
  } catch {
    throw new Error("verifier: invalid GitHub pagination URL");
  }
  if (
    url.origin !== GITHUB_API_ORIGIN || url.username || url.password ||
    url.hash
  ) {
    throw new Error("verifier: unsafe GitHub pagination URL");
  }
  return `${url.pathname}${url.search}`;
};

// Paths that define what runs, what counts as passing, and what produces the
// artifacts the evaluator trusts. A candidate diff touching any of these
// cannot be allowed to authorize itself — see gate-drift spec. No allowlist,
// label, or env override may exempt a path from this list; the single
// content-shaped exemption is `isWorkspaceLinkOnlyPatch` below, which admits
// nothing but `workspace:*` links between this repository's own packages.
// `scripts/` deliberately supersedes `scripts/ci/`: it also covers the
// scripts every lane's `package.json`/`deno.json` task indirects through
// (`run-tests.ts`,
// `check-ui-architecture.mjs`, `verify-ui-stories.ts`, `generate-*.ts`,
// `lint/`, `lib/`). `docs/technical-design/ui-baselines/paper/` is the Paper
// baseline image directory (the baseline-replacement attack); the sibling
// `components.json` catalog file is deliberately NOT gated here — that's
// ordinary UI work already defended by the `ui_catalog` lane.
export const GATE_PATH_PREFIXES = [
  ".github/workflows/",
  "scripts/",
  "packages/ui/scripts/",
  "packages/ui/.storybook/",
  "docs/technical-design/ui-baselines/paper/",
  "packages/ui/catalog/",
] as const;

// Root-level exact-path gate definition files that a prefix can't express.
export const GATE_PATH_FILES = [
  ".tool-versions",
  "deno.lock",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "docs/technical-design/ui-baselines/paper-baselines.json",
  "docs/technical-design/ui-baselines/route-references.json",
  "docs/technical-design/ui-baselines/guardrail-baseline.json",
  "docs/technical-design/ui-baselines/enterprise-baselines.json",
] as const;

// Basenames gated at any depth: every workspace's package.json and Deno/
// Turbo/Vite/Vitest config (e.g. `apps/server/deno.json` is the effective
// config for the API process a lane probes; `apps/web/vite.config.ts`
// builds the dev server a lane's Playwright config starts), every
// Playwright config, every tsconfig variant, and every pnpmfile/npmrc
// spelling (`.pnpmfile.cjs`, the ESM `.pnpmfile.mjs`, and the bare
// `pnpmfile.cjs` a workspace can point at via its own `pnpmfile` config;
// all execute/configure before any check runs and can rewrite resolution
// or patch gated files on disk after checkout) at any depth, not just the
// repository root.
export const GATE_PATH_BASENAMES = [
  "package.json",
  "playwright.config.ts",
  "deno.json",
  "deno.jsonc",
  "turbo.json",
  "vite.config.ts",
  "vitest.config.ts",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
  "pnpmfile.cjs",
  ".npmrc",
] as const;

const tsconfigBasenamePattern = /^tsconfig.*\.json$/;

const isGatedPath = (path: string): boolean => {
  if (GATE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }
  if ((GATE_PATH_FILES as readonly string[]).includes(path)) return true;
  const basename = path.slice(path.lastIndexOf("/") + 1);
  if ((GATE_PATH_BASENAMES as readonly string[]).includes(basename)) {
    return true;
  }
  return tsconfigBasenamePattern.test(basename);
};

// A workspace package depending on a sibling workspace package is ordinary
// feature work, not gate drift: `workspace:*` resolves only to a directory
// inside this repository, pulls in no external code, and cannot change what
// a lane runs. So a *modified* `package.json` or the root `pnpm-lock.yaml`
// whose every added/removed line is one of the shapes pnpm writes for such a
// link is not a gate hit. Everything else about these files stays gated: any
// other dependency specifier, any `scripts`/config edit, a rename, an added
// or deleted file, or a diff GitHub returned no `patch` for (too large) —
// all fail closed.
const workspaceLinkLinePatterns = {
  "package.json": [
    /^[+-]\s*"@bakery\/[a-z0-9-]+": "workspace:\*",?$/,
  ],
  "pnpm-lock.yaml": [
    /^[+-]\s*'@bakery\/[a-z0-9-]+':$/,
    /^[+-]\s*specifier: workspace:\*$/,
    /^[+-]\s*version: link:(?:\.\.\/)+(?:packages|apps)\/[a-z0-9-]+$/,
  ],
} as const;

export type ChangedFileEntry = {
  filename: string;
  status?: string;
  previous_filename?: string;
  patch?: string;
};

export function isWorkspaceLinkOnlyPatch(entry: ChangedFileEntry): boolean {
  if (entry.status !== "modified" || entry.previous_filename) return false;
  if (typeof entry.patch !== "string" || entry.patch.length === 0) return false;
  const basename = entry.filename.slice(entry.filename.lastIndexOf("/") + 1);
  const patterns = entry.filename === "pnpm-lock.yaml"
    ? workspaceLinkLinePatterns["pnpm-lock.yaml"]
    : basename === "package.json"
    ? workspaceLinkLinePatterns["package.json"]
    : null;
  if (!patterns) return false;
  let changedLines = 0;
  for (const line of entry.patch.split("\n")) {
    if (
      line === "" || line.startsWith("@@") || line.startsWith(" ") ||
      line.startsWith("\\")
    ) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) return false;
    if (!patterns.some((pattern) => pattern.test(line))) return false;
    changedLines += 1;
  }
  return changedLines > 0;
}

export function resolveOpenPull(
  pulls: readonly PullSummary[],
  expected: { repository: string; headSha: string },
): PullSummary | null {
  const openPulls = pulls.filter((candidate) =>
    candidate.state === "open" &&
    candidate.head.sha === expected.headSha &&
    candidate.base.ref === "main" &&
    candidate.head.repo.full_name === expected.repository &&
    candidate.base.repo.full_name === expected.repository
  );
  return openPulls.length === 1 ? openPulls[0] : null;
}

// GitHub's compare status is "ahead" (live is ahead of recorded — the
// common case), "diverged" (both moved — e.g. a force-push rewrote main),
// or "behind" (recorded is ahead of live — history was rewound); all three
// mean the base the candidate ran against is no longer the base a fresh
// run would see, so all three count as drift. "identical" (no drift) is
// the only non-drift outcome.
export function isBaseDrift(compareStatus: string | undefined): boolean {
  return compareStatus === "ahead" || compareStatus === "diverged" ||
    compareStatus === "behind";
}
export function isBaseShaDrift(
  recordedBaseSha: string,
  liveBaseSha: string,
): boolean {
  return recordedBaseSha !== liveBaseSha;
}

export function formatVerifierReason(failures: readonly string[]): string {
  return `${failures.length > 0 ? failures.join("\n") : "run accepted"}\n`;
}
export async function resolveLiveBaseDrift(
  fetchJson: (path: string) => Promise<{
    ok: boolean;
    status: number;
    body: unknown;
    linkHeader: string | null;
  }>,
  repository: string,
  recordedBaseSha: string,
): Promise<{ baseAdvanced: boolean; apiFailures: string[] }> {
  const liveBasePath = `/repos/${repository}/git/ref/heads/main`;
  const liveBaseResponse = await fetchJson(liveBasePath);
  if (!liveBaseResponse.ok) {
    return {
      baseAdvanced: false,
      apiFailures: [`api: ${liveBaseResponse.status} ${liveBasePath}`],
    };
  }
  const liveBaseSha = (
    liveBaseResponse.body as {
      object?: { sha?: unknown };
    } | null
  )?.object?.sha;
  if (typeof liveBaseSha !== "string") {
    return {
      baseAdvanced: false,
      apiFailures: [`api: malformed response ${liveBasePath}`],
    };
  }
  return {
    baseAdvanced: isBaseShaDrift(recordedBaseSha, liveBaseSha),
    apiFailures: [],
  };
}

// Fetches a PR's full changed-file list from the paginated `/pulls/{n}/files`
// endpoint (following `Link: rel="next"`, never hand-built `page=`), and
// cross-checks the collected entry count against the PR's own
// `changed_files` so a diff padded past whatever the caller enumerated
// cannot silently disable the gate. `fetchJson` is injected so this is
// testable without a real network call. Renames contribute both `filename`
// (new path) and `previous_filename` (old path) to `changedPaths`, so moving
// a gate-defining file out from under a gated prefix cannot escape it.
export async function enumerateChangedPaths(
  fetchJson: (path: string) => Promise<{
    ok: boolean;
    status: number;
    body: unknown;
    linkHeader: string | null;
  }>,
  pullDetailsPath: string,
  filesPath: string,
  candidateHeadSha: string,
): Promise<
  { changedPaths: string[]; apiFailures: string[]; postJobFailures: string[] }
> {
  const details = await fetchJson(pullDetailsPath);
  if (!details.ok) {
    return {
      changedPaths: [],
      apiFailures: [`api: ${details.status} ${pullDetailsPath}`],
      postJobFailures: ["gate: changed file list unavailable"],
    };
  }
  const detailsBody = details.body as
    | { changed_files?: unknown; head?: { sha?: unknown } }
    | null;

  // A push landing between the earlier commits/{sha}/pulls snapshot and
  // this fetch would otherwise let the diff be enumerated against the PR's
  // new (unverified) head while the status still targets the old one. A
  // missing/non-string head.sha is a malformed body, not evidence of an
  // advance, so it gets the same refusal as any other malformed response.
  const liveHeadSha = detailsBody?.head?.sha;
  if (typeof liveHeadSha !== "string") {
    return {
      changedPaths: [],
      apiFailures: [],
      postJobFailures: ["gate: changed file list unavailable"],
    };
  }
  if (liveHeadSha !== candidateHeadSha) {
    return {
      changedPaths: [],
      apiFailures: [],
      postJobFailures: [
        "pr: head advanced during verification; re-run verifier",
      ],
    };
  }

  const expectedCount = detailsBody?.changed_files;
  if (typeof expectedCount !== "number") {
    return {
      changedPaths: [],
      apiFailures: [],
      postJobFailures: ["gate: changed file list unavailable"],
    };
  }

  const changedPaths: string[] = [];
  let entryCount = 0;
  let path: string | null = filesPath;
  while (path) {
    const response = await fetchJson(path);
    if (!response.ok) {
      return {
        changedPaths: [],
        apiFailures: [`api: ${response.status} ${path}`],
        postJobFailures: [],
      };
    }
    if (!Array.isArray(response.body)) {
      return {
        changedPaths: [],
        apiFailures: [],
        postJobFailures: ["gate: changed file list unavailable"],
      };
    }
    const entries = response.body as ChangedFileEntry[];
    entryCount += entries.length;
    for (const entry of entries) {
      if (isWorkspaceLinkOnlyPatch(entry)) continue;
      changedPaths.push(entry.filename);
      if (entry.previous_filename) changedPaths.push(entry.previous_filename);
    }
    const link = response.linkHeader ?? "";
    const next = link.split(",").find((part) => part.includes('rel="next"'));
    const match = next?.match(/<([^>]+)>/) ?? null;
    path = match ? normalizeGithubApiPath(match[1]) : null;
  }

  if (entryCount !== expectedCount) {
    return {
      changedPaths,
      apiFailures: [],
      postJobFailures: ["gate: candidate diff not fully enumerated"],
    };
  }
  return { changedPaths, apiFailures: [], postJobFailures: [] };
}

export function verifyRun(
  policy: RequiredChecksPolicy,
  run: RunSummary,
  jobs: readonly JobSummary[],
  pulls: readonly PullSummary[],
  changedPaths: readonly string[],
  expected: {
    repository: string;
    headSha: string;
    runAttempt: string;
    baseAdvanced?: boolean;
    baseUnrecorded?: boolean;
    postJobFailures?: readonly string[];
  },
): {
  failures: string[];
  laneResults: Record<string, string>;
  pull: PullSummary | null;
} {
  const failures: string[] = [];
  if (run.path !== policy.workflowPath) {
    failures.push("run: workflow path mismatch");
  }
  if (run.event !== "pull_request") {
    failures.push("run: event is not pull_request");
  }
  if (run.head_sha !== expected.headSha || !headShaPattern.test(run.head_sha)) {
    failures.push("run: head sha mismatch");
  }
  if (String(run.run_attempt) !== expected.runAttempt) {
    failures.push("run: attempt mismatch");
  }
  if (run.head_repository.full_name !== expected.repository) {
    failures.push(`run: head repository is not ${expected.repository}`);
  }
  if (run.conclusion !== "success") {
    failures.push(`run: conclusion ${run.conclusion}`);
  }

  const pull = resolveOpenPull(pulls, expected);
  if (!pull) {
    failures.push(
      "pr: exactly one open pull request required for candidate head",
    );
  }
  if (pull && pull.merge_commit_sha === null) {
    failures.push("pr: merge commit unavailable; re-run verifier");
  }

  const checkJob = (name: string): string => {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length === 0) {
      failures.push(`job ${name}: missing`);
      return "missing";
    }
    if (matches.length > 1) {
      failures.push(`job ${name}: duplicated`);
      return matches[0].conclusion ?? "missing";
    }
    const conclusion = matches[0].conclusion ?? "missing";
    if (conclusion !== "success") {
      failures.push(`job ${name}: ${conclusion}`);
    }
    return conclusion;
  };

  // A pull request runs the bounded fast gate: the post-merge lanes are
  // expected to be absent from it, reported by GitHub as `skipped`. Only
  // `skipped` passes — a heavy lane that ran, failed or disappeared on a pull
  // request means the routing is wrong, not that the candidate is clean.
  const checkSkippedJob = (name: string): string => {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length === 0) {
      failures.push(`job ${name}: missing`);
      return "missing";
    }
    if (matches.length > 1) {
      failures.push(`job ${name}: duplicated`);
      return "duplicated";
    }
    const conclusion = matches[0].conclusion ?? "missing";
    if (conclusion !== "skipped") {
      failures.push(
        `job ${name}: post-merge lane must be skipped on a pull request, observed ${conclusion}`,
      );
    }
    return conclusion;
  };

  const laneResults: Record<string, string> = {};
  for (const lane of policy.lanes) {
    laneResults[lane.lane] = lane.pullRequestRequired !== false
      ? checkJob(lane.job)
      : checkSkippedJob(lane.job);
  }
  checkJob(policy.aggregateJob);

  // Base-drift and enumeration failures are pushed after job checks, before
  // gate checks, so a genuine job failure still stays `failures[0]` — a PR
  // whose real test failure merely races a push to main, or whose diff
  // enumeration failed, must be told to fix the failure, not to "re-run
  // Bakery CI"/"re-run verifier".
  if (pull) {
    if (expected.baseUnrecorded) {
      failures.push("pr: candidate run has no recorded base; re-run Bakery CI");
    } else if (expected.baseAdvanced) {
      failures.push("pr: base advanced since candidate run; re-run Bakery CI");
    }
  }
  if (expected.postJobFailures) {
    failures.push(...expected.postJobFailures);
  }
  // Gate-drift failures are appended last, after run/pr/job failures, so a
  // genuine job failure stays the headline reason (gate-drift spec).
  for (const path of changedPaths) {
    if (isGatedPath(path)) {
      failures.push(`gate: candidate modifies ${path}`);
    }
  }

  return { failures, laneResults, pull };
}

if (import.meta.main) {
  const token = Deno.env.get("GITHUB_TOKEN") ?? "";
  const repository = Deno.env.get("GITHUB_REPOSITORY") ?? "";
  const runId = Deno.env.get("RUN_ID") ?? "";
  const runAttempt = Deno.env.get("RUN_ATTEMPT") ?? "";
  const headSha = Deno.env.get("HEAD_SHA") ?? "";
  const policyPath = Deno.env.get("REQUIRED_CHECKS_POLICY") ??
    "scripts/ci/required-checks.json";
  const reasonPath = Deno.env.get("VERIFIER_REASON_PATH");

  let policy: RequiredChecksPolicy;
  try {
    policy = parsePolicy(await Deno.readTextFile(policyPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (reasonPath) await Deno.writeTextFile(reasonPath, `${message}\n`);
    Deno.exit(1);
  }

  try {
    const apiFailures: string[] = [];
    const authHeaders = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
    const fetchJson = async (path: string) => {
      const response = await fetch(`https://api.github.com${path}`, {
        headers: authHeaders,
      });
      const body = await response.json().catch(() => null);
      return {
        ok: response.ok,
        status: response.status,
        body,
        linkHeader: response.headers.get("link"),
      };
    };

    const runPath = `/repos/${repository}/actions/runs/${runId}`;
    const runResponse = await fetch(`https://api.github.com${runPath}`, {
      headers: authHeaders,
    });
    if (!runResponse.ok) {
      apiFailures.push(`api: ${runResponse.status} ${runPath}`);
    }
    const run = runResponse.ok ? await runResponse.json() as RunSummary : {
      path: "",
      event: "",
      head_sha: "",
      run_attempt: 0,
      conclusion: null,
      head_repository: { full_name: "" },
    };

    const jobs: JobSummary[] = [];
    let jobsPath: string | null =
      `/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`;
    while (jobsPath) {
      const jobsResponse: Response = await fetch(
        `https://api.github.com${jobsPath}`,
        { headers: authHeaders },
      );
      if (!jobsResponse.ok) {
        apiFailures.push(`api: ${jobsResponse.status} ${jobsPath}`);
        break;
      }
      const page = await jobsResponse.json() as { jobs: JobSummary[] };
      jobs.push(...page.jobs);
      const link: string = jobsResponse.headers.get("link") ?? "";
      const next: string | undefined = link.split(",").find((
        part: string,
      ) => part.includes('rel="next"'));
      const match: RegExpMatchArray | null = next?.match(/<([^>]+)>/) ?? null;
      jobsPath = match ? normalizeGithubApiPath(match[1]) : null;
    }

    const pullsPath =
      `/repos/${repository}/commits/${headSha}/pulls?state=open&per_page=100`;
    const pullsResponse = await fetch(`https://api.github.com${pullsPath}`, {
      headers: authHeaders,
    });
    if (!pullsResponse.ok) {
      apiFailures.push(`api: ${pullsResponse.status} ${pullsPath}`);
    }
    const pulls = pullsResponse.ok
      ? await pullsResponse.json() as PullSummary[]
      : [];

    const candidatePull = resolveOpenPull(pulls, { repository, headSha });

    // Finding 7 (TOCTOU): the run's own pull-request reference may record
    // the base the candidate actually ran against, independent of any
    // evidence the candidate wrote. Missing/non-matching data is its own
    // explicit refusal (not a silent skip) — see the RunSummary comment.
    let baseAdvanced = false;
    let baseUnrecorded = false;
    if (candidatePull) {
      const recordedEntry = run.pull_requests?.find((pr) =>
        pr.number === candidatePull.number
      );
      if (!recordedEntry) {
        baseUnrecorded = true;
      } else if (recordedEntry.base.sha !== candidatePull.base.sha) {
        const compareBasePath =
          `/repos/${repository}/compare/${recordedEntry.base.sha}...${candidatePull.base.sha}`;
        const compareBaseResponse = await fetch(
          `https://api.github.com${compareBasePath}`,
          { headers: authHeaders },
        );
        if (!compareBaseResponse.ok) {
          apiFailures.push(
            `api: ${compareBaseResponse.status} ${compareBasePath}`,
          );
        } else {
          const compareBaseBody = await compareBaseResponse.json() as {
            status?: string;
          };
          baseAdvanced = isBaseDrift(compareBaseBody.status);
        }
      }
      if (recordedEntry) {
        const liveBase = await resolveLiveBaseDrift(
          fetchJson,
          repository,
          recordedEntry.base.sha,
        );
        baseAdvanced ||= liveBase.baseAdvanced;
        apiFailures.push(...liveBase.apiFailures);
      }
    }

    // Finding 2 (gate-drift): enumerate the candidate's changed files
    // (renames contribute both old and new paths) and cross-check
    // completeness against the PR's own changed_files count, and its head
    // sha against HEAD_SHA, so a padded diff or a mid-verification push
    // cannot disable the gate. When no PR resolved, the pr: failure above
    // already refuses the candidate, so an empty list is correct. Its
    // `gate:`/`pr:` refusals are routed to `postJobFailures` (not
    // `apiFailures`) so a genuine job failure still stays `failures[0]`;
    // only true transport errors (`api: <status> <path>`) are prepended.
    const changedPaths: string[] = [];
    const postJobFailures: string[] = [];
    if (candidatePull) {
      const enumeration = await enumerateChangedPaths(
        fetchJson,
        `/repos/${repository}/pulls/${candidatePull.number}`,
        `/repos/${repository}/pulls/${candidatePull.number}/files?per_page=100`,
        headSha,
      );
      changedPaths.push(...enumeration.changedPaths);
      apiFailures.push(...enumeration.apiFailures);
      postJobFailures.push(...enumeration.postJobFailures);
    }

    const { failures, laneResults, pull } = verifyRun(
      policy,
      run,
      jobs,
      pulls,
      changedPaths,
      {
        repository,
        headSha,
        runAttempt,
        baseAdvanced,
        baseUnrecorded,
        postJobFailures,
      },
    );
    const allFailures = [...apiFailures, ...failures];

    const outputPath = Deno.env.get("GITHUB_OUTPUT");
    const envPath = Deno.env.get("GITHUB_ENV");
    if (allFailures.length === 0 && outputPath) {
      await Deno.writeTextFile(
        outputPath,
        [
          `candidate_sha=${run.head_sha}`,
          `base_sha=${pull?.base.sha ?? ""}`,
          `merge_sha=${pull?.merge_commit_sha ?? ""}`,
          `pr_number=${pull?.number ?? ""}`,
          "",
        ].join("\n"),
        { append: true },
      );
    }
    if (envPath) {
      await Deno.writeTextFile(
        envPath,
        Object.entries(laneResults).map(([lane, result]) =>
          `LANE_${lane.toUpperCase()}=${result}\n`
        ).join(""),
        { append: true },
      );
    }
    if (reasonPath) {
      await Deno.writeTextFile(reasonPath, formatVerifierReason(allFailures));
    }
    if (allFailures.length > 0) {
      console.error(formatVerifierReason(allFailures).trimEnd());
      Deno.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (reasonPath) await Deno.writeTextFile(reasonPath, `${message}\n`);
    Deno.exit(1);
  }
}
