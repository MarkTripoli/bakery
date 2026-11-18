import { assert } from "@std/assert";
import { parse } from "yaml";

// A job that runs a script out of this repository needs the repository. That
// sounds too obvious to assert, which is exactly why it shipped broken twice.
//
// The nightly signal job first ran `deno run` without installing Deno (exit
// 127), then with Deno but without a checkout (exit 1, "Module not found"):
// both times `continue-on-error` reported the job successful, so a signal that
// never executed was indistinguishable from one that ran and found nothing to
// do. The unit tests for the signal's decision logic stayed green throughout,
// because they inject every collaborator and so cannot see an empty workspace.
//
// This rail asks the narrow question: does a job whose steps name a repository
// script also check the repository out? A checkout into any path counts, since
// what matters is that the files are on disk.
//
// `trusted-policy/scripts/...` is a different repository, brought in by its own
// step, so those runs are not evidence either way and are ignored.

const WORKFLOW = new URL("../../.github/workflows/ci.yml", import.meta.url);

/** `scripts/...` but not `trusted-policy/scripts/...`. */
const REPOSITORY_SCRIPT = /(?<!trusted-policy\/)scripts\//;

type Step = { run?: unknown; uses?: unknown };
type Job = { steps?: unknown };

function isStep(value: unknown): value is Step {
  return typeof value === "object" && value !== null;
}

Deno.test("every job that runs a repository script checks the repository out", async () => {
  const workflow = parse(await Deno.readTextFile(WORKFLOW)) as {
    jobs?: Record<string, Job>;
  };
  const jobs = workflow?.jobs ?? {};
  assert(
    Object.keys(jobs).length > 0,
    "no jobs parsed out of .github/workflows/ci.yml; the parse is broken rather than the workflow",
  );

  const offenders: string[] = [];
  const misordered: string[] = [];
  // Accumulate the names, not just a count: a bare `checked > 0` guard cannot
  // notice the job this rail exists for falling out of scope, so renaming
  // `scripts/ci/nightly-signal.ts` would leave this rail green while the
  // nightly signal silently stopped being covered.
  const checked: string[] = [];
  for (const [name, job] of Object.entries(jobs)) {
    if (!Array.isArray(job?.steps)) continue;
    const steps = job.steps.filter(isStep);
    const scriptIndex = steps.findIndex((step) =>
      typeof step.run === "string" && REPOSITORY_SCRIPT.test(step.run)
    );
    if (scriptIndex < 0) continue;
    checked.push(name);
    const checkoutIndex = steps.findIndex((step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/checkout@")
    );
    if (checkoutIndex < 0) offenders.push(name);
    // A checkout placed after the script runs leaves the same empty workspace:
    // present in the file, useless at the moment it is needed.
    else if (checkoutIndex > scriptIndex) misordered.push(name);
  }

  assert(
    checked.length > 0,
    "no job was found running a repository script, so this rail proved nothing; the workflow's shape changed",
  );
  assert(
    checked.includes("nightly_signal"),
    `the nightly_signal job is no longer among the jobs running a repository script, so nothing checks the job this rail exists for: checked ${
      checked.join(", ")
    }`,
  );
  assert(
    offenders.length === 0,
    `these jobs run a script from this repository without checking it out, so the script cannot exist on disk and the step fails with "Module not found" while continue-on-error reports success: ${
      offenders.join(", ")
    }`,
  );
  assert(
    misordered.length === 0,
    `these jobs check the repository out after the step that runs its script, so the first run still sees an empty workspace: ${
      misordered.join(", ")
    }`,
  );
});

// The same concealment, one layer out. `nightly-signal.ts` reads the run it is
// signalling about before it writes anything, so the job's token needs
// `actions: read`. It declared `contents: read` and `issues: write` only, so the
// very first API call it made was refused; `continue-on-error` reported the job
// successful and the tracking issue was never created on any red night. The
// defect is a permissions block, not code, so no unit test could have seen it -
// the signal injects a fake `gh` and the fake is never refused.
//
// This asks the narrow question the failure needs answered: does the job that
// runs the signal grant the read its first step depends on?
type JobPermissions = { actions?: unknown };

Deno.test("the job that reads a run's jobs may read actions", async () => {
  const workflow = parse(await Deno.readTextFile(WORKFLOW)) as {
    jobs?: Record<string, Job & { permissions?: unknown }>;
  };
  const jobs = workflow?.jobs ?? {};
  const signal = jobs["nightly_signal"];
  assert(
    signal !== undefined,
    "the nightly_signal job is gone, so this rail proved nothing; the workflow's shape changed",
  );
  const permissions = signal.permissions as JobPermissions | undefined;
  assert(
    permissions !== undefined && typeof permissions === "object",
    "the nightly_signal job has no permissions block, so it inherits a default that cannot read the run it signals about",
  );
  assert(
    permissions.actions === "read",
    `the nightly_signal job must declare \`actions: read\`; it reads repos/:repo/actions/runs/:id/jobs as its first call and is refused without it, while continue-on-error reports success: found ${
      JSON.stringify(permissions.actions ?? null)
    }`,
  );
});
