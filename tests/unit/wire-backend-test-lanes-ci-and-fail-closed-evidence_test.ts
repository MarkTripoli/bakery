import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "@std/assert";
import {
  enterpriseDebtCaseIds,
  enterpriseNotSelectableIds,
  evaluateArtifacts,
  evaluateEvidence,
  evaluateRequiredLanes,
  type LanePolicy,
  parsePolicy,
} from "../../scripts/ci/evaluate.ts";
import { assertWorkflowArtifactTransportPolicy } from "../../scripts/ci/runner-label-policy.mjs";
import { AFFECTED_LANES_TABLE } from "../../scripts/ci/classify-changes.ts";
import { writeEvidence } from "../../scripts/ci/write-evidence.ts";

const candidateSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const workflowSha = "c".repeat(40);
const runId = "123456789";
const runAttempt = "2";
const dependencies = "deno:2.9.1,node:22.22.0,pnpm:10.33.0";

const readWorkflow = (name: string) =>
  Deno.readTextFile(`.github/workflows/${name}`);

/** The body of one job of `ci.yml`, from its id line to the next job. */
const jobBodyOf = (workflow: string, id: string): string => {
  const [, jobsBlock] = workflow.split(/^jobs:\n/m);
  const found = jobsBlock.split(/^\x20{2}(?=[a-z0-9_]+:\n)/m)
    .find((candidate) => candidate.startsWith(`${id}:\n`));
  assert(found, `job ${id} exists`);
  return found;
};

const jobIdsOf = (workflow: string): string[] => {
  const [, jobsBlock] = workflow.split(/^jobs:\n/m);
  return [...jobsBlock.matchAll(/^ {2}([a-z0-9_]+):\n/gm)].map((match) =>
    match[1]
  );
};

const expectedLaneOrder = [
  "rails",
  "git_diff_check",
  "semantic_metadata",
  "format",
  "typecheck",
  "contract_description_gate",
  "contract_description_gate_b",
  "contract_description_gate_c",
  "focused_unit_tests",
  "focused_unit_tests_b",
  "provider_tests",
  "ui_catalog",
  "ui_quality",
  "ui_architecture",
  "ui_storybook_browser",
  "integration_tests",
  "security_tests",
  "recovery_tests",
  "browser_tests",
  "ui_web_browser",
  "ui_web_browser_b",
  "ui_web_browser_c",
  "ui_web_browser_d",
  "e2e_tests",
  "ui_paper_runtime",
  "ui_paper_entitlements",
  "ui_paper_artifacts",
  "native_worker",
];

// runner.temp is unavailable in workflow-level env, so each job's first step
// exports these under the runner's own temp dir via $RUNNER_TEMP.
const perRunnerHandoffRoot = '"$RUNNER_TEMP/bakery-ci-$RUN_ID-$RUN_ATTEMPT"';

const evidence = (workflow = workflowSha) =>
  [
    "lane=format",
    `candidate_sha=${candidateSha}`,
    `base_sha=${baseSha}`,
    `workflow_sha=${workflow}`,
    `run_id=${runId}`,
    `run_attempt=${runAttempt}`,
    `dependencies=${dependencies}`,
    "command=pnpm lint",
    "exit_code=0",
    "test_cases=formatter, linter, and suppression guard",
    "coverage=not-collected",
    "artifacts=none",
    "redacted=true",
    "",
  ].join("\n");

Deno.test("aggregate rejects missing, skipped, canceled, and failed evidence", () => {
  const required = ["format", "typecheck", "integration"] as const;
  for (
    const status of [undefined, "skipped", "cancelled", "failure"] as const
  ) {
    const result = evaluateRequiredLanes({
      format: "success",
      typecheck: "success",
      integration: status,
    }, required);
    assertEquals(result.ok, false);
    assert(result.failures.includes("integration"));
  }
});

Deno.test("aggregate accepts only explicit success for every required lane", () => {
  const result = evaluateRequiredLanes(
    { format: "success", typecheck: "success", integration: "success" },
    ["format", "typecheck", "integration"],
  );
  assertEquals(result, { ok: true, failures: [] });
});

Deno.test("aggregate accepts complete matching evidence", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(`${directory}/format.txt`, evidence());
  assertEquals(
    await evaluateEvidence(
      directory,
      ["format"],
      candidateSha,
      baseSha,
      workflowSha,
      runId,
      runAttempt,
      dependencies,
    ),
    [],
  );
});

Deno.test("aggregate rejects absent or mismatched evidence artifacts", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(`${directory}/format.txt`, evidence("d".repeat(40)));
  const failures = await evaluateEvidence(
    directory,
    ["format", "unit"],
    candidateSha,
    baseSha,
    workflowSha,
    runId,
    runAttempt,
    dependencies,
  );
  assertEquals(failures.length, 2);
  assert(failures.every((failure) => failure.includes("evidence")));
});

Deno.test("evaluator rejects missing and mismatched run identity", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${directory}/format.txt`, evidence());
    for (
      const [expectedRunId, expectedRunAttempt] of [
        ["other-run", runAttempt],
        [runId, "other-attempt"],
      ]
    ) {
      assertEquals(
        (await evaluateEvidence(
          directory,
          ["format"],
          candidateSha,
          baseSha,
          workflowSha,
          expectedRunId,
          expectedRunAttempt,
          dependencies,
        )).length,
        1,
      );
    }
    for (const field of [`run_id=${runId}\n`, `run_attempt=${runAttempt}\n`]) {
      await Deno.writeTextFile(
        `${directory}/format.txt`,
        evidence().replace(field, ""),
      );
      assertEquals(
        (await evaluateEvidence(
          directory,
          ["format"],
          candidateSha,
          baseSha,
          workflowSha,
          runId,
          runAttempt,
          dependencies,
        )).length,
        1,
      );
    }
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("evidence writer output passes evaluator run identity checks", async () => {
  const directory = await Deno.makeTempDir();
  try {
    await writeEvidence({
      lane: "native",
      command: "deno test tests/native",
      testCases: "tracked native tests",
      status: "success",
      candidate: candidateSha,
      base: baseSha,
      workflow: workflowSha,
      runId,
      runAttempt,
      artifacts: "none",
    }, `${directory}/evidence`);
    assertEquals(
      await evaluateEvidence(
        `${directory}/evidence`,
        ["native"],
        candidateSha,
        baseSha,
        workflowSha,
        runId,
        runAttempt,
        dependencies,
      ),
      [],
    );
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test(
  "evaluator accepts positive prior attempts and rejects invalid attempts",
  async () => {
    const directory = await Deno.makeTempDir();
    try {
      for (const attempt of ["1", "2"]) {
        await writeEvidence({
          lane: "native",
          command: "deno test tests/native",
          testCases: "tracked native tests",
          status: "success",
          candidate: candidateSha,
          base: baseSha,
          workflow: workflowSha,
          runId,
          runAttempt: attempt,
          artifacts: "none",
        }, `${directory}/evidence`);
        assertEquals(
          await evaluateEvidence(
            `${directory}/evidence`,
            ["native"],
            candidateSha,
            baseSha,
            workflowSha,
            runId,
            runAttempt,
            dependencies,
          ),
          [],
        );
      }
      for (const attempt of ["3", "0", "not-an-attempt"]) {
        await writeEvidence({
          lane: "native",
          command: "deno test tests/native",
          testCases: "tracked native tests",
          status: "success",
          candidate: candidateSha,
          base: baseSha,
          workflow: workflowSha,
          runId,
          runAttempt: attempt,
          artifacts: "none",
        }, `${directory}/evidence`);
        assertEquals(
          (await evaluateEvidence(
            `${directory}/evidence`,
            ["native"],
            candidateSha,
            baseSha,
            workflowSha,
            runId,
            runAttempt,
            dependencies,
          )).length,
          1,
        );
      }
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  },
);

Deno.test("evaluator rejects blank expected workflow SHA", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(`${directory}/format.txt`, evidence());
  assertEquals(
    await evaluateEvidence(
      directory,
      ["format"],
      candidateSha,
      baseSha,
      "",
      runId,
      runAttempt,
      dependencies,
    ),
    ["candidate, base, workflow, and run identity are required"],
  );
});

Deno.test("evaluator rejects missing workflow field", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${directory}/format.txt`,
    evidence().replace(`workflow_sha=${workflowSha}\n`, ""),
  );
  assertEquals(
    (await evaluateEvidence(
      directory,
      ["format"],
      candidateSha,
      baseSha,
      workflowSha,
      runId,
      runAttempt,
      dependencies,
    )).length,
    1,
  );
});

Deno.test("evaluator rejects mismatched workflow field", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(`${directory}/format.txt`, evidence("d".repeat(40)));
  assertEquals(
    (await evaluateEvidence(
      directory,
      ["format"],
      candidateSha,
      baseSha,
      workflowSha,
      runId,
      runAttempt,
      dependencies,
    )).length,
    1,
  );
});

Deno.test("evaluator rejects duplicate workflow fields", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${directory}/format.txt`,
    `${evidence()}workflow_sha=${workflowSha}\n`,
  );
  assertEquals(
    (await evaluateEvidence(
      directory,
      ["format"],
      candidateSha,
      baseSha,
      workflowSha,
      runId,
      runAttempt,
      dependencies,
    )).length,
    1,
  );
});

Deno.test("evaluator rejects missing artifacts field", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${directory}/format.txt`,
    evidence().replace("artifacts=none\n", ""),
  );
  assertEquals(
    (await evaluateEvidence(
      directory,
      ["format"],
      candidateSha,
      baseSha,
      workflowSha,
      runId,
      runAttempt,
      dependencies,
    )).length,
    1,
  );
});

Deno.test("evidence rejects duplicate keys and unpinned dependencies", async () => {
  const directory = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${directory}/format.txt`,
    `${
      evidence().replace(
        `dependencies=${dependencies}`,
        "dependencies=deno:latest",
      )
    }exit_code=1\n`,
  );
  assertEquals(
    (await evaluateEvidence(
      directory,
      ["format"],
      candidateSha,
      baseSha,
      workflowSha,
      runId,
      runAttempt,
      dependencies,
    )).length,
    1,
  );
});

Deno.test("ci aggregate runs rails and diff checks", async () => {
  const workflow = await readWorkflow("ci.yml");
  assert(workflow.includes("git_diff_check:"));
  const storybookBuild = workflow.indexOf(
    "run: pnpm --dir packages/ui build-storybook",
  );
  const railsTest = workflow.indexOf("run: pnpm test:rails");
  assert(storybookBuild >= 0);
  assert(railsTest > storybookBuild);
  assert(workflow.includes("run: git diff --check"));
  assert(workflow.includes("WORKFLOW_SHA: ${{ github.workflow_sha }}"));
});

Deno.test(
  "ordinary backend e2e launches the identity full stack in a delegated cgroup",
  async () => {
    const workflow = await readWorkflow("ci.yml");
    const e2eStart = workflow.indexOf("\n  e2e:\n");
    const e2eEnd = workflow.indexOf("\n  ui_paper_runtime:\n", e2eStart);
    assert(
      e2eStart >= 0 && e2eEnd > e2eStart,
      "backend e2e job block not found",
    );
    const e2eBlock = workflow.slice(e2eStart, e2eEnd);
    assert(e2eBlock.includes("run: pnpm test:e2e"));
    // The web journey drives chromium and runs the worker in a user scope.
    assert(e2eBlock.includes("pnpm exec playwright install chromium"));
    assert(e2eBlock.includes("systemd-run --user --scope"));
    assert(e2eBlock.includes("command -v bwrap"));

    const wrapper = await Deno.readTextFile(
      "tests/e2e/run-fixed-secret-identity-full-stack_test.ts",
    );
    assert(wrapper.includes('new Deno.Command("systemd-run"'));
    assert(wrapper.includes('"--property=Delegate=yes"'));
    assert(wrapper.includes("`--setenv=DOCKER_HOST=${dockerHost}`"));
    assert(
      wrapper.includes("`--setenv=BAKERY_E2E_OWNER_UNIT=${ownerUnit}`"),
    );
    assert(wrapper.includes('"--allow-run"'));
    assert(wrapper.includes('"--allow-net"'));
    assert(!wrapper.includes('"--allow-all"'));
    assert(
      wrapper.includes('"./run-fixed-secret-identity-full-stack.child.ts"'),
    );

    const child = await Deno.readTextFile(
      "tests/e2e/run-fixed-secret-identity-full-stack.child.ts",
    );
    assert(child.includes("provisionDelegatedCgroupV2"));
    assert(child.includes("admitEngineOwnedSecretIdentityRun"));
    assert(child.includes("startOwnedSystemdUnit"));
    assert(child.includes('command: "pnpm"'));
    assert(
      child.includes('args: ["--filter", "@bakery/worker", "start"]'),
    );
    assert(child.includes("bindToUnit: ownerUnit"));
    assert(child.includes("stopOwnedSystemdUnit"));
    assert(child.indexOf("await stack.down()") < child.indexOf("console.log"));
  },
);

Deno.test("recovery is a required lane with Postgres roles, bwrap and a user scope", async () => {
  const workflow = await readWorkflow("ci.yml");
  const start = workflow.indexOf("\n  recovery:\n");
  const end = workflow.indexOf("\n  browser:\n", start);
  assert(start >= 0 && end > start, "recovery job block not found");
  const recovery = workflow.slice(start, end);
  assert(recovery.includes("name: full / recovery"));
  assert(recovery.includes("services:\n      postgres:"));
  assert(recovery.includes("Provision migration test roles and database"));
  assert(recovery.includes("BAKERY_APP_DATABASE_URL="));
  assert(recovery.includes("command -v bwrap"));
  assert(recovery.includes("systemd-run --user --scope"));
  assert(recovery.includes("run: pnpm test:recovery"));
  assert(recovery.includes("write-evidence.ts recovery_tests "));
  assert(recovery.includes("emit-log recovery_tests"));
  const aggregate = workflow.slice(workflow.indexOf("  aggregate:"));
  assert(aggregate.includes("      recovery,\n"));
  assert(aggregate.includes('"$LANE_RECOVERY_TESTS" \\'));
});

Deno.test("backend rails checks out the base ref history for architecture contraction", async () => {
  const workflow = await readWorkflow("ci.yml");
  const start = workflow.indexOf("\n  rails:\n");
  const end = workflow.indexOf("\n  git_diff_check:\n", start);
  assert(start >= 0 && end > start, "backend rails job block not found");
  const rails = workflow.slice(start, end);
  assertMatch(
    rails,
    /- uses: actions\/checkout@[^\n]+\n\s+with:\n\s+fetch-depth: 0\n\s+persist-credentials: false/,
  );
});

function workflowJob(jobsBlock: string, name: string): string {
  const found = jobsBlock.split(/^\x20{2}(?=[a-z0-9_]+:\n)/m)
    .find((candidate) => candidate.startsWith(`${name}:\n`));
  assert(found, `job ${name} exists`);
  return found;
}

Deno.test("web lanes pick free ports instead of fixed shared-host ports", async () => {
  const workflow = await readWorkflow("ci.yml");
  const [, jobsBlock] = workflow.split(/^jobs:\n/m);
  const job = (name: string): string => workflowJob(jobsBlock, name);
  for (
    const name of [
      "ui_web",
      "ui_web_b",
      "ui_web_c",
      "ui_web_d",
      "ui_paper_runtime",
      "ui_paper_entitlements",
      "ui_paper_artifacts",
    ]
  ) {
    const body = job(name);
    assert(
      body.includes('echo "BAKERY_WEB_PORT=$web_port"') ||
        body.includes('echo "BAKERY_WEB_PORT=$port"'),
    );
    assert(body.includes('>> "$GITHUB_ENV"'));
    assert(!body.includes("127.0.0.1:5173"), `${name} has no fixed web port`);
  }
  const web = job("ui_web");
  assert(web.includes('echo "BAKERY_SERVER_PORT=$server_port"'));
  assert(!/BAKERY_SERVER_PORT:\s*"?8000"?/.test(web), "no job-level API port");
  assert(!web.includes("127.0.0.1:8000"), "readiness uses the picked API port");
  assert(
    web.includes('"http://127.0.0.1:$BAKERY_SERVER_PORT/health/ready"'),
  );
  // The port step must run before the API starts and before readiness checks.
  const portStep = web.indexOf("Pick free web and API ports");
  assert(portStep >= 0);
  assert(portStep < web.indexOf("Start API"));
  assert(portStep < web.indexOf("Wait for API health"));
});

Deno.test("ordinary ci evidence writers propagate workflow SHA locally", async () => {
  const workflow = await readWorkflow("ci.yml");
  assertMatch(workflow, /^\x20{2}RUN_ID: \$\{\{ github\.run_id \}\}$/m);
  assertMatch(
    workflow,
    /^\x20{2}RUN_ATTEMPT: \$\{\{ github\.run_attempt \}\}$/m,
  );
  assertMatch(
    workflow,
    /^\x20{2}BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \|\| github\.sha \}\}$/m,
  );
  assert(!workflow.includes("/tmp/bakery-ci-"));
  assert(
    !/^\x20{2}(HANDOFF_ROOT|HANDOFF_DIR|EVIDENCE_DIR|ARTIFACT_DIR):/m
      .test(workflow),
  );
  const [, jobsBlock] = workflow.split(/^jobs:\n/m);
  const jobs = jobsBlock.split(/^\x20{2}(?=[a-z0-9_]+:\n)/m).filter(Boolean);
  const handoffJobNames: string[] = [];
  for (const job of jobs) {
    if (!/HANDOFF_(DIR|ROOT)|EVIDENCE_DIR|ARTIFACT_DIR/.test(job)) continue;
    handoffJobNames.push(/^([a-z0-9_]+):/.exec(job)![1]);
    const firstStep = job.split(/^\x20{4}steps:\n/m)[1] ?? "";
    assert(firstStep.startsWith("      - name: Select per-runner handoff"));
    const body = firstStep.split(/^\x20{6}- /m)[1];
    assert(body.includes(`root=${perRunnerHandoffRoot}`));
    assert(body.includes('echo "HANDOFF_ROOT=$root"'));
    assert(body.includes('echo "HANDOFF_DIR=$root/$GITHUB_JOB"'));
    assert(body.includes('echo "EVIDENCE_DIR=$root/$GITHUB_JOB/evidence"'));
    assert(
      body.includes(
        'echo "ARTIFACT_DIR=$root/$GITHUB_JOB/candidate-artifacts"',
      ),
    );
    assert(body.includes('>> "$GITHUB_ENV"'));
  }
  assertEquals(
    handoffJobNames.sort(),
    [
      "aggregate",
      "browser",
      "contract",
      "contract_shard_b",
      "contract_shard_c",
      "e2e",
      "format",
      "git_diff_check",
      "integration",
      "native_worker",
      "provider",
      "rails",
      "recovery",
      "security",
      "semantic_metadata",
      "typecheck",
      "ui_architecture",
      "ui_catalog",
      "ui_paper_artifacts",
      "ui_paper_entitlements",
      "ui_paper_runtime",
      "ui_quality",
      "ui_storybook_browser",
      "ui_web",
      "ui_web_b",
      "ui_web_c",
      "ui_web_d",
      "unit",
      "unit_shard_b",
    ],
  );
  for (
    const match of workflow.matchAll(
      /- name: Write [\s\S]*?run: deno run [^\n]*write-evidence\.ts[^\n]*/g,
    )
  ) {
    assert(match[0].includes("WORKFLOW_SHA: ${{ github.workflow_sha }}"));
  }
});

Deno.test("required-checks policy matches ci.yml lane wiring exactly", async () => {
  const policy = parsePolicy(
    await Deno.readTextFile("scripts/ci/required-checks.json"),
  );
  assertEquals(policy.lanes.map((lane) => lane.lane), expectedLaneOrder);
  const workflow = await readWorkflow("ci.yml");
  const aggregateBlock = workflow.slice(workflow.indexOf("  aggregate:"));
  assert(aggregateBlock.includes("Reject invalid direct lane results"));
  assert(aggregateBlock.includes("LANE_RAILS:"));
  assert(aggregateBlock.includes("LANE_UI_PAPER_RUNTIME:"));
  assert(!aggregateBlock.includes("scripts/ci/release-evidence.ts"));
  assert(!aggregateBlock.includes("scripts/ci/evaluate.ts"));
  assert(!aggregateBlock.includes("RUN_LANE_LOG_MANIFEST"));

  const jobIdByName = new Map<string, string>();
  for (
    const match of workflow.matchAll(/^ {2}([A-Za-z0-9_]+):\n {4}name: (.+)$/gm)
  ) {
    jobIdByName.set(match[2], match[1]);
  }

  for (const lane of policy.lanes) {
    const jobId = jobIdByName.get(lane.job);
    assert(jobId, `no job id found for job name: ${lane.job}`);
    assert(
      workflow.includes(
        `LANE_${lane.lane.toUpperCase()}: "\${{ needs.${jobId}.result }}"`,
      ),
      `LANE_${lane.lane.toUpperCase()} does not map to needs.${jobId}.result`,
    );
  }
});

Deno.test("pull-request lane flags match the workflow gate routing", async () => {
  const policy = parsePolicy(
    await Deno.readTextFile("scripts/ci/required-checks.json"),
  );
  const workflow = await readWorkflow("ci.yml");
  const [, jobsBlock] = workflow.split(/^jobs:\n/m);
  const jobBody = (id: string): string => {
    const found = jobsBlock.split(/^\x20{2}(?=[a-z0-9_]+:\n)/m)
      .find((candidate) => candidate.startsWith(`${id}:\n`));
    assert(found, `job ${id} exists`);
    return found;
  };
  const jobIdByName: Record<string, string> = Object.fromEntries(
    [...workflow.matchAll(/^ {2}([A-Za-z0-9_]+):\n {4}name: (.+)$/gm)]
      .map((match) => [match[2], match[1]]),
  );

  let gated = 0;
  let postMerge = 0;
  for (const lane of policy.lanes) {
    const jobId = jobIdByName[lane.job];
    assert(jobId, `no job id found for job name: ${lane.job}`);
    const body = jobBody(jobId);
    const condition = body.split("\n").find((line) =>
      line.startsWith("    if: ")
    );
    // A lane without an `if:` runs on every route, so it is pull-request
    // required; a lane whose condition admits `gate` is too. Anything else
    // must be declared post-merge in the policy, and vice versa. The
    // same-repository guard only keeps fork pull requests off self-hosted
    // runners; it does not route, so a lane gated by it alone runs everywhere.
    const forkGuard =
      "    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";
    const admitsGate = condition === undefined || condition === forkGuard ||
      condition.includes("needs.changes.outputs.route == 'gate'");
    assertEquals(
      lane.pullRequestRequired !== false,
      admitsGate,
      `${lane.lane}: policy pullRequestRequired disagrees with ci.yml routing`,
    );
    // #330: a pull request must never wait for the self-hosted pool, so every
    // lane it runs is on a GitHub-hosted image.
    if (admitsGate) {
      assertMatch(
        body,
        /^ {4}runs-on: ubuntu-24\.04$/m,
        `${lane.lane}: a lane a pull request runs must use a GitHub-hosted runner`,
      );
    }
    if (admitsGate) gated++;
    else postMerge++;
  }
  assert(gated > 0, "the gate runs at least one lane");
  assert(postMerge > 0, "at least one lane is post-merge only");
  assert(
    workflow.includes('if [[ "$ROUTE" == gate ]]; then'),
    "the aggregate branches on the gate route",
  );
  assert(
    workflow.includes("post-merge lane ran on a pull request"),
    "the aggregate rejects a post-merge lane on a pull request",
  );
});

Deno.test("the route job, the docs validation, the aggregate and the description policy run on GitHub-hosted runners", async () => {
  // The route job and the docs validation are not required-check lanes, so the
  // per-lane rule does not reach them. The aggregate is the last job of every
  // pull-request run and the description policy answers every issue and
  // pull-request edit: none of these may queue behind the self-hosted pool
  // (#330).
  const workflow = await readWorkflow("ci.yml");
  for (const id of ["changes", "docs_validation", "aggregate"]) {
    assertMatch(
      jobBodyOf(workflow, id),
      /^ {4}runs-on: ubuntu-24\.04$/m,
      `${id} must use a GitHub-hosted runner`,
    );
  }
  const policy = await readWorkflow("description-policy.yml");
  assertEquals(
    [...policy.matchAll(/^ {4}runs-on: (.+)$/gm)].map((match) => match[1]),
    ["ubuntu-24.04", "ubuntu-24.04"],
  );
});

Deno.test("fork pull requests are skipped at the root jobs, and no other job is a root", async () => {
  // Four jobs have no `needs`: the route job, the two cheap root lanes and the
  // aggregate. Each skips a fork pull request with the same-repository guard;
  // every other job needs one of them, so a skipped root skips it too.
  const workflow = await readWorkflow("ci.yml");
  const guard =
    "github.event.pull_request.head.repo.full_name == github.repository";
  const roots = ["changes", "git_diff_check", "semantic_metadata", "aggregate"];
  for (const id of roots) {
    const condition = jobBodyOf(workflow, id).split("\n").find((line) =>
      line.startsWith("    if: ")
    );
    assert(
      condition?.includes(guard),
      `${id} must skip fork pull requests with the same-repository guard`,
    );
  }
  for (const id of jobIdsOf(workflow)) {
    if (id === "aggregate") continue;
    const needsAnother = /^ {4}needs: /m.test(jobBodyOf(workflow, id));
    assertEquals(
      needsAnother,
      !roots.includes(id),
      `${id}: only the root jobs may run without needs (a fork pull request would reach it)`,
    );
  }
});

Deno.test("affected push routing selects lanes through the classifier union", async () => {
  const policy = parsePolicy(
    await Deno.readTextFile("scripts/ci/required-checks.json"),
  );
  const workflow = await readWorkflow("ci.yml");
  const [, jobsBlock] = workflow.split(/^jobs:\n/m);
  const jobBody = (id: string): string => {
    const found = jobsBlock.split(/^\x20{2}(?=[a-z0-9_]+:\n)/m)
      .find((candidate) => candidate.startsWith(`${id}:\n`));
    assert(found, `job ${id} exists`);
    return found;
  };
  const jobIdByName: Record<string, string> = Object.fromEntries(
    [...workflow.matchAll(/^ {2}([A-Za-z0-9_]+):\n {4}name: (.+)$/gm)]
      .map((match) => [match[2], match[1]]),
  );
  const policyLanes = new Set(policy.lanes.map((lane) => lane.lane));
  // Heavy lanes (post-merge in the policy) are conditionally selected on the
  // affected route through their own lane key in the classifier's table; fast
  // lanes always run, so their if only adds the bare affected route.
  for (const lane of policy.lanes) {
    const body = jobBody(jobIdByName[lane.job]);
    const condition = body.split("\n").find((line) =>
      line.startsWith("    if: ")
    );
    const keySelected = (condition?.includes(
      "needs.changes.outputs.route == 'affected'",
    ) &&
      condition?.includes(
        `contains(fromJSON(needs.changes.outputs.lanes), '${lane.lane}')`,
      )) ?? false;
    const touchedByTable = AFFECTED_LANES_TABLE.some((rule) =>
      rule.lanes?.includes(lane.lane)
    );
    const isHeavy = lane.pullRequestRequired === false;
    assertEquals(
      keySelected,
      policyLanes.has(lane.lane) && touchedByTable && isHeavy,
      `${lane.lane}: affected routing disagrees with required-checks.json lane table`,
    );
  }
  assert(
    workflow.includes('AFFECTED_LANES: "${{ needs.changes.outputs.lanes }}"'),
    "the aggregate receives the affected lane union",
  );
  assert(
    workflow.includes('if [[ "$ROUTE" == affected ]]; then'),
    "the aggregate branches on the affected route",
  );
  assert(
    workflow.includes("affected lane did not succeed"),
    "a selected affected lane that did not succeed rejects",
  );
  assert(
    workflow.includes("unselected lane ran on the affected route"),
    "an unselected heavy lane that still ran rejects",
  );
});

Deno.test("classify-changes emits a lanes output on every route", async () => {
  const workflow = await readWorkflow("ci.yml");
  assert(
    workflow.includes(
      "      lanes: ${{ steps.classify.outputs.lanes }}",
    ),
    "the changes job publishes the affected lane union",
  );
});

Deno.test(
  "candidate Bakery CI has no trusted-verifier labels or reusable calls",
  async () => {
    const workflow = await readWorkflow("ci.yml");
    assert(workflow.includes("on:"));
    assert(workflow.includes("pull_request:"));
    assert(workflow.includes("push:"));
    assert(!workflow.includes("trusted-verifier"));
    assert(!workflow.includes("aggregate_acquisition"));
    const aggregate = workflow.slice(workflow.indexOf("  aggregate:"));
    assert(aggregate.includes("Reject invalid direct lane results"));
    assert(!aggregate.includes("RUN_LANE_LOG_MANIFEST"));
    assert(!aggregate.includes("scripts/ci/release-evidence.ts"));
    assert(!aggregate.includes("scripts/ci/evaluate.ts"));
  },
);

Deno.test("contract generation compares the candidate with the PR base", async () => {
  const workflow = await readWorkflow("ci.yml");
  assert(workflow.includes("pnpm contracts:generate -- --base-ref"));
  assert(workflow.includes("github.event_name == 'pull_request'"));
  assert(workflow.includes(
    "--compatibility-migration docs/technical-design/contract-migrations/v1-unreleased-principal-organization-contracts.json",
  ));
  assert(workflow.includes(
    "git diff --exit-code -- packages/contracts/generated/",
  ));
  assert(workflow.includes("pnpm catalog:literals:check"));
});

Deno.test("TypeSafe advisory steps can never gate and always run for pull requests", async () => {
  const workflow = await readWorkflow("ci.yml");
  // Steps in this workflow start at six-space indentation under `steps:`.
  const steps = workflow.split(/\n(?=\x20{6}- )/);
  const advisory = steps.filter((step) =>
    step.includes("secrets.TYPESAFE_API_KEY")
  );
  assert(advisory.length >= 2, "expected the TypeSafe advisory steps");
  for (const step of advisory) {
    // Must run even when the deterministic gate before it failed, and must
    // never fail the job: the regex/rail stays the gate.
    assert(
      step.includes(
        "if: ${{ !cancelled() && github.event_name == 'pull_request' }}",
      ),
      step,
    );
    assert(step.includes("continue-on-error: true"), step);
    assert(step.includes("--allow-net=api.typesafe.ai"), step);
    assert(step.includes('--allow-write="$GITHUB_STEP_SUMMARY"'), step);
    assert(!/(?:^|\s)-A\b|--allow-all|--allow-write(?:\s|$)/.test(step), step);
  }
  // The secret reaches only the advisory steps.
  assertEquals(
    workflow.split("secrets.TYPESAFE_API_KEY").length - 1,
    advisory.length,
  );
  // A newer pull-request run supersedes the older one on the same ref. A main
  // push never cancels the push before it (#330): the running push finishes and
  // GitHub keeps one newer push pending behind it, so main gets completed runs
  // instead of a stream of cancelled ones. Scheduled and manual runs keep their
  // own group.
  assert(workflow.includes(
    "group: bakery-ci-${{ (github.event_name == 'pull_request' || github.event_name == 'push') && github.ref || github.run_id }}",
  ));
  assert(workflow.includes(
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
  ));
  assert(
    !/cancel-in-progress:[^\n]*'push'/.test(workflow),
    "a main push must not cancel the push before it",
  );
  // The title gate validates the squashed subject.
  assert(workflow.includes('--pull-request-number "$PR_NUMBER"'));
});

Deno.test("workflow actions use immutable commit pins", async () => {
  for await (const entry of Deno.readDir(".github/workflows")) {
    if (!entry.isFile) continue;
    const workflow = await Deno.readTextFile(`.github/workflows/${entry.name}`);
    for (
      const line of workflow.split("\n").filter((line) => /\buses:/.test(line))
    ) {
      assertMatch(line, /uses: [^@]+@[0-9a-f]{40}/, `${entry.name}: ${line}`);
    }
  }
});

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest)).map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const runtimeManifestPolicy: LanePolicy = {
  lane: "ui_capture",
  job: "ui / candidate capture",
  artifacts: [{
    path: "artifacts/ui-baseline/runtime/manifest.json",
    verify: "runtime-manifest",
  }],
};

const paperComparisonPolicy: LanePolicy = {
  lane: "ui_paper",
  job: "ui / paper parity",
  artifacts: [{
    path: "artifacts/ui-baseline/paper/comparison.json",
    verify: "paper-comparison",
  }],
};

const passingRuntimeManifest = {
  schemaVersion: 2,
  cases: [{ status: "passed" }],
  coverage: { failed: 0, blocked: 0, missing: [] },
};

const passingPaperComparison = {
  schemaVersion: 2,
  threshold: 0.95,
  status: "passed",
  results: [{ status: "passed" }],
  coverage: { expected: 1, failed: 0, blocked: 0, missing: [] },
};

async function writeArtifactFixture(
  evidenceDir: string,
  artifactDir: string,
  lane: LanePolicy,
  documentContent: string,
  declaredDigestOverride?: string,
): Promise<void> {
  const path = lane.artifacts[0].path;
  const fullPath = `${artifactDir}/${path}`;
  await Deno.mkdir(fullPath.slice(0, fullPath.lastIndexOf("/")), {
    recursive: true,
  });
  const bytes = new TextEncoder().encode(documentContent);
  await Deno.writeFile(fullPath, bytes);
  const digest = declaredDigestOverride ?? await sha256Hex(bytes);
  await Deno.writeTextFile(
    `${evidenceDir}/${lane.lane}.txt`,
    `artifacts=${path}:${digest}\n`,
  );
}

Deno.test("parsePolicy rejects a duplicate lane id", () => {
  const text = JSON.stringify({
    workflow: "Bakery CI",
    workflowPath: ".github/workflows/ci.yml",
    aggregateJob: "required / full-stack aggregate",
    dependencies,
    lanes: [
      { lane: "rails", job: "fast / backend rails", artifacts: [] },
      { lane: "rails", job: "fast / other rails", artifacts: [] },
    ],
  });
  assertThrows(
    () => parsePolicy(text),
    Error,
    "policy: invalid required-checks policy",
  );
});

Deno.test("parsePolicy rejects a duplicate job name across different lane ids", () => {
  const text = JSON.stringify({
    workflow: "Bakery CI",
    workflowPath: ".github/workflows/ci.yml",
    aggregateJob: "required / full-stack aggregate",
    dependencies,
    lanes: [
      { lane: "rails", job: "fast / backend rails", artifacts: [] },
      { lane: "rails_two", job: "fast / backend rails", artifacts: [] },
    ],
  });
  assertThrows(
    () => parsePolicy(text),
    Error,
    "policy: invalid required-checks policy",
  );
});

Deno.test("parsePolicy rejects an unknown verify value", () => {
  const text = JSON.stringify({
    workflow: "Bakery CI",
    workflowPath: ".github/workflows/ci.yml",
    aggregateJob: "required / full-stack aggregate",
    dependencies,
    lanes: [
      {
        lane: "ui_capture",
        job: "ui / candidate capture",
        artifacts: [{
          path: "artifacts/ui-baseline/runtime/manifest.json",
          verify: "unsupported",
        }],
      },
    ],
  });
  assertThrows(
    () => parsePolicy(text),
    Error,
    "policy: invalid required-checks policy",
  );
});

Deno.test("parsePolicy rejects a traversal artifact path", () => {
  const text = JSON.stringify({
    workflow: "Bakery CI",
    workflowPath: ".github/workflows/ci.yml",
    aggregateJob: "required / full-stack aggregate",
    dependencies,
    lanes: [
      {
        lane: "ui_capture",
        job: "ui / candidate capture",
        artifacts: [{
          path: "../secret.json",
          verify: "runtime-manifest",
        }],
      },
    ],
  });
  assertThrows(
    () => parsePolicy(text),
    Error,
    "policy: invalid required-checks policy",
  );
});

Deno.test("evaluateArtifacts denies a digest mismatch", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      runtimeManifestPolicy,
      JSON.stringify(passingRuntimeManifest),
      "0".repeat(64),
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      runtimeManifestPolicy,
    ]);
    assertEquals(failures, [
      "ui_capture: artifact artifacts/ui-baseline/runtime/manifest.json missing or digest mismatch",
    ]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies artifacts=none when the policy expects artifacts", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${evidenceDir}/ui_capture.txt`,
      "artifacts=none\n",
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      runtimeManifestPolicy,
    ]);
    assertEquals(failures, ["ui_capture: artifact declaration mismatch"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies a runtime manifest with coverage.failed = 1", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    const manifest = {
      ...passingRuntimeManifest,
      coverage: { ...passingRuntimeManifest.coverage, failed: 1 },
    };
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      runtimeManifestPolicy,
      JSON.stringify(manifest),
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      runtimeManifestPolicy,
    ]);
    assertEquals(failures, ["ui_capture: runtime manifest rejects capture"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies a non-JSON runtime manifest instead of throwing", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      runtimeManifestPolicy,
      "not json",
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      runtimeManifestPolicy,
    ]);
    assertEquals(failures, ["ui_capture: runtime manifest rejects capture"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies a paper comparison with threshold = 0.9", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    const comparison = { ...passingPaperComparison, threshold: 0.9 };
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      paperComparisonPolicy,
      JSON.stringify(comparison),
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      paperComparisonPolicy,
    ]);
    assertEquals(failures, ["ui_paper: paper comparison not passed"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies a paper comparison with status = blocked", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    const comparison = { ...passingPaperComparison, status: "blocked" };
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      paperComparisonPolicy,
      JSON.stringify(comparison),
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      paperComparisonPolicy,
    ]);
    assertEquals(failures, ["ui_paper: paper comparison not passed"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

// compare-paper.mjs reports a deliberately out-of-scope design artboard as an
// "excluded" result with its reason rather than dropping it from the report.
// The aggregate must accept that, or every run of a branch carrying exclusions
// is refused for a parity failure that did not happen.
Deno.test("evaluateArtifacts accepts a paper comparison carrying an excluded artboard", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    const comparison = {
      ...passingPaperComparison,
      results: [
        { status: "passed" },
        { status: "excluded", reason: "out of scope for this product" },
      ],
    };
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      paperComparisonPolicy,
      JSON.stringify(comparison),
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      paperComparisonPolicy,
    ]);
    assertEquals(failures, []);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

// Accepting "excluded" must not let a report that compares nothing pass.
Deno.test("evaluateArtifacts denies a paper comparison that compares no baseline", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    const comparison = {
      ...passingPaperComparison,
      results: [{ status: "excluded", reason: "out of scope" }],
      coverage: { expected: 0, failed: 0, blocked: 0, missing: [] },
    };
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      paperComparisonPolicy,
      JSON.stringify(comparison),
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      paperComparisonPolicy,
    ]);
    assertEquals(failures, ["ui_paper: paper comparison not passed"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies a non-JSON paper comparison instead of throwing", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      paperComparisonPolicy,
      "not json",
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      paperComparisonPolicy,
    ]);
    assertEquals(failures, ["ui_paper: paper comparison not passed"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts accepts a passing runtime manifest and paper comparison pair", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      runtimeManifestPolicy,
      JSON.stringify(passingRuntimeManifest),
    );
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      paperComparisonPolicy,
      JSON.stringify(passingPaperComparison),
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      runtimeManifestPolicy,
      paperComparisonPolicy,
    ]);
    assertEquals(failures, []);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

const enterpriseLane: LanePolicy = {
  lane: "ui_paper",
  job: "ui / paper parity",
  artifacts: [
    ...paperComparisonPolicy.artifacts,
    {
      path: "artifacts/ui-baseline/enterprise/runtime/manifest.json",
      verify: "enterprise-runtime-manifest",
    },
    {
      path: "artifacts/ui-baseline/enterprise/paper/comparison.json",
      verify: "enterprise-paper-comparison",
    },
  ],
};

// Auth pair plus the enterprise pair, as the evidence branch declares them.
const authRuntimeArtifact = {
  path: "artifacts/ui-baseline/runtime/manifest.json",
  verify: "runtime-manifest" as const,
};
const fullLane: LanePolicy = {
  ...enterpriseLane,
  artifacts: [authRuntimeArtifact, ...enterpriseLane.artifacts],
};

const ledgerWithPlanned = {
  entries: [
    {
      routeId: "tasks",
      status: "planned",
      manifest: "enterprise",
      cases: ["queue.default.light.desktop"],
    },
    {
      routeId: "setup",
      status: "baselined",
      manifest: "auth",
      cases: ["setup.default.light.desktop"],
    },
  ],
};

const passingEnterpriseComparison = {
  schemaVersion: 2,
  threshold: 0.95,
  status: "passed",
  results: [
    { baselineId: "queue.default.light.desktop", status: "planned" },
  ],
  coverage: { expected: 1, failed: 0, blocked: 0, missing: [], planned: 1 },
};

const emptyEnterpriseManifest = {
  schemaVersion: 2,
  cases: [],
  coverage: { failed: 0, blocked: 0, missing: [] },
};

// Evaluates a lane carrying the auth pair (always passing) plus the given
// enterprise documents; `undefined` leaves an artifact unwritten but declared.
async function evaluateEnterprise(
  documents: {
    manifest?: unknown;
    comparison?: unknown;
    authComparison?: unknown;
  },
  ledger: unknown = ledgerWithPlanned,
  baselines: unknown = baselinesWithCases,
): Promise<string[]> {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    const contents = new Map<string, unknown>([
      [authRuntimeArtifact.path, passingRuntimeManifest],
      [
        "artifacts/ui-baseline/paper/comparison.json",
        documents.authComparison ?? passingPaperComparison,
      ],
      [
        "artifacts/ui-baseline/enterprise/runtime/manifest.json",
        documents.manifest,
      ],
      [
        "artifacts/ui-baseline/enterprise/paper/comparison.json",
        documents.comparison,
      ],
    ]);
    const declared: string[] = [];
    for (const [path, content] of contents) {
      if (content === undefined) {
        declared.push(`${path}:${"0".repeat(64)}`);
        continue;
      }
      const full = `${artifactDir}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      const bytes = new TextEncoder().encode(JSON.stringify(content));
      await Deno.writeFile(full, bytes);
      declared.push(`${path}:${await sha256Hex(bytes)}`);
    }
    await Deno.writeTextFile(
      `${evidenceDir}/ui_paper.txt`,
      `artifacts=${declared.join(",")}\n`,
    );
    return await evaluateArtifacts(
      evidenceDir,
      artifactDir,
      [fullLane],
      () => Promise.resolve(ledger),
      () => Promise.resolve(baselines),
    );
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
}

Deno.test("parsePolicy accepts the enterprise verify kinds", () => {
  const policy = parsePolicy(JSON.stringify({
    workflow: "Bakery CI",
    workflowPath: ".github/workflows/ci.yml",
    aggregateJob: "required / full-stack aggregate",
    dependencies,
    lanes: [{ ...fullLane }],
  }));
  assertEquals(
    policy.lanes[0].artifacts.map((artifact) => artifact.verify),
    [
      "runtime-manifest",
      "paper-comparison",
      "enterprise-runtime-manifest",
      "enterprise-paper-comparison",
    ],
  );
});

Deno.test("evaluateArtifacts accepts an all-planned enterprise capture with an empty manifest", async () => {
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison: passingEnterpriseComparison,
    }),
    [],
  );
});

Deno.test("evaluateArtifacts accepts the manifest self-check result beside planned cases in an empty capture", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    results: [
      { baselineId: "manifest", status: "introduced" },
      { baselineId: "queue.default.light.desktop", status: "planned" },
    ],
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison,
    }),
    [],
  );
});

const baselinesWithCases = {
  cases: [
    { id: "queue.default.light.desktop" },
    { id: "session.default.light.desktop" },
    { id: "d" },
  ],
};

const ledgerWithBaselined = {
  entries: [
    ...ledgerWithPlanned.entries,
    {
      routeId: "task-detail",
      status: "baselined",
      manifest: "enterprise",
      cases: ["session.default.light.desktop"],
    },
  ],
};

Deno.test("enterpriseNotSelectableIds excludes baselined and planned ids and fails closed", () => {
  assertEquals(
    [...enterpriseNotSelectableIds(ledgerWithBaselined, baselinesWithCases)],
    ["d"],
  );
  assertEquals(enterpriseNotSelectableIds(null, baselinesWithCases).size, 0);
  assertEquals(enterpriseNotSelectableIds(ledgerWithBaselined, null).size, 0);
});

Deno.test("evaluateArtifacts denies not-selected for a baselined enterprise case", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    results: [
      { baselineId: "session.default.light.desktop", status: "not-selected" },
    ],
  };
  assertEquals(
    await evaluateEnterprise(
      { manifest: { ...passingRuntimeManifest }, comparison },
      ledgerWithBaselined,
    ),
    ["ui_paper: enterprise paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts denies not-selected for an id absent from the trusted baselines", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    results: [{ baselineId: "invented.case", status: "not-selected" }],
  };
  assertEquals(
    await evaluateEnterprise(
      { manifest: { ...passingRuntimeManifest }, comparison },
      ledgerWithBaselined,
    ),
    ["ui_paper: enterprise paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts accepts enterprise passed, introduced, excluded and not-selected results", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    results: [
      { baselineId: "a", status: "passed" },
      { baselineId: "b", status: "introduced" },
      { baselineId: "c", status: "excluded", reason: "out of scope" },
      { baselineId: "d", status: "not-selected" },
      { baselineId: "queue.default.light.desktop", status: "planned" },
    ],
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: { ...passingRuntimeManifest },
      comparison,
    }),
    [],
  );
});

const debtBaselines = {
  cases: [
    {
      id: "session.default.light.desktop",
      reference: "design",
      frameId: "HU-0",
    },
    {
      id: "session.default.light.phone",
      reference: "design",
      frameId: "P6-0",
    },
    { id: "queue.default.light.desktop", reference: "design", frameId: "5J-0" },
  ],
};

const ledgerWithDebt = {
  entries: [
    ...ledgerWithPlanned.entries,
    {
      routeId: "task-detail",
      status: "debt",
      frames: [{ frameId: "HU-0" }, { frameId: "P6-0" }],
    },
  ],
};

const debtComparison = {
  ...passingEnterpriseComparison,
  results: [
    { baselineId: "queue.default.light.desktop", status: "planned" },
    { baselineId: "session.default.light.desktop", status: "debt" },
    { baselineId: "session.default.light.phone", status: "debt" },
  ],
  coverage: {
    expected: 3,
    failed: 0,
    blocked: 0,
    missing: [],
    planned: 1,
    debt: 2,
  },
};

Deno.test("enterpriseDebtCaseIds maps debt frames to design cases and fails closed", () => {
  assertEquals(
    [...enterpriseDebtCaseIds(ledgerWithDebt, debtBaselines)].sort(),
    ["session.default.light.desktop", "session.default.light.phone"],
  );
  assertEquals(enterpriseDebtCaseIds(null, debtBaselines).size, 0);
  assertEquals(enterpriseDebtCaseIds(ledgerWithDebt, null).size, 0);
  assertEquals(enterpriseDebtCaseIds({ entries: "x" }, debtBaselines).size, 0);
  // A debt-excluded id is reported as debt, so it is never not-selectable.
  assertEquals(
    [...enterpriseNotSelectableIds(ledgerWithDebt, debtBaselines)],
    [],
  );
});

Deno.test("evaluateArtifacts accepts debt results the trusted ledger and manifest map to a debt entry", async () => {
  assertEquals(
    await evaluateEnterprise(
      { manifest: emptyEnterpriseManifest, comparison: debtComparison },
      ledgerWithDebt,
      debtBaselines,
    ),
    [],
  );
});

Deno.test("evaluateArtifacts denies untrusted debt results", async () => {
  // Ledger without a debt entry: the candidate cannot declare its own debt.
  assertEquals(
    await evaluateEnterprise(
      { manifest: emptyEnterpriseManifest, comparison: debtComparison },
      ledgerWithPlanned,
      debtBaselines,
    ),
    ["ui_paper: enterprise paper comparison not passed"],
  );
  // Unreadable ledger or manifest accepts no debt.
  for (
    const [ledger, baselines] of [
      [null, debtBaselines],
      ["nope", debtBaselines],
      [ledgerWithDebt, null],
    ] as const
  ) {
    assertEquals(
      await evaluateEnterprise(
        { manifest: emptyEnterpriseManifest, comparison: debtComparison },
        ledger,
        baselines,
      ),
      ["ui_paper: enterprise paper comparison not passed"],
    );
  }
  // A debt result for a case whose frame is not a debt frame.
  assertEquals(
    await evaluateEnterprise(
      {
        manifest: emptyEnterpriseManifest,
        comparison: {
          ...debtComparison,
          results: [
            { baselineId: "queue.default.light.desktop", status: "debt" },
          ],
        },
      },
      ledgerWithDebt,
      debtBaselines,
    ),
    ["ui_paper: enterprise paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts never accepts debt under the auth comparison", async () => {
  assertEquals(
    await evaluateEnterprise(
      {
        manifest: emptyEnterpriseManifest,
        comparison: debtComparison,
        authComparison: {
          ...passingPaperComparison,
          results: [
            { baselineId: "session.default.light.desktop", status: "debt" },
          ],
        },
      },
      ledgerWithDebt,
      debtBaselines,
    ),
    ["ui_paper: paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts denies an enterprise failed result", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    results: [{ baselineId: "a", status: "failed" }],
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: passingRuntimeManifest,
      comparison,
    }),
    ["ui_paper: enterprise paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts denies an enterprise blocked result and blocked coverage", async () => {
  const blocked = {
    ...passingEnterpriseComparison,
    status: "blocked",
    results: [{ baselineId: "a", status: "blocked" }],
    coverage: { expected: 1, failed: 0, blocked: 1, missing: [] },
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: passingRuntimeManifest,
      comparison: blocked,
    }),
    ["ui_paper: enterprise paper comparison not passed"],
  );
  const coverageOnly = {
    ...passingEnterpriseComparison,
    coverage: { ...passingEnterpriseComparison.coverage, blocked: 1 },
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison: coverageOnly,
    }),
    ["ui_paper: enterprise paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts denies an enterprise comparison with missing cases", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    coverage: { ...passingEnterpriseComparison.coverage, missing: ["x"] },
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison,
    }),
    ["ui_paper: enterprise paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts denies a planned result for a case the ledger does not mark planned", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    results: [{ baselineId: "invented.case", status: "planned" }],
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison,
    }),
    ["ui_paper: enterprise paper comparison not passed"],
  );
  // A baselined (non-planned) ledger entry for that id does not qualify, nor
  // does a planned entry on the auth manifest.
  const authPlanned = {
    entries: [{
      routeId: "tasks",
      status: "planned",
      manifest: "auth",
      cases: ["queue.default.light.desktop"],
    }],
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison: passingEnterpriseComparison,
    }, authPlanned),
    ["ui_paper: enterprise paper comparison not passed"],
  );
});

Deno.test("evaluateArtifacts denies every planned result when the ledger is unreadable", async () => {
  for (const ledger of [null, "nope", { entries: "x" }]) {
    assertEquals(
      await evaluateEnterprise({
        manifest: emptyEnterpriseManifest,
        comparison: passingEnterpriseComparison,
      }, ledger),
      ["ui_paper: enterprise paper comparison not passed"],
    );
  }
});

Deno.test("evaluateArtifacts denies planned and not-selected results under the auth comparison", async () => {
  for (const status of ["planned", "not-selected"]) {
    const authComparison = {
      ...passingPaperComparison,
      results: [{
        baselineId: "queue.default.light.desktop",
        status,
      }],
    };
    assertEquals(
      await evaluateEnterprise({
        manifest: emptyEnterpriseManifest,
        comparison: passingEnterpriseComparison,
        authComparison,
      }),
      ["ui_paper: paper comparison not passed"],
      status,
    );
  }
});

Deno.test("evaluateArtifacts denies an empty enterprise manifest that hides a captured case", async () => {
  const comparison = {
    ...passingEnterpriseComparison,
    results: [
      { baselineId: "queue.default.light.desktop", status: "planned" },
      { baselineId: "a", status: "passed" },
    ],
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison,
    }),
    ["ui_paper: enterprise runtime manifest rejects capture"],
  );
});

Deno.test("evaluateArtifacts denies an enterprise runtime manifest with a failed case", async () => {
  const manifest = {
    ...passingRuntimeManifest,
    cases: [{ status: "passed" }, { status: "failed" }],
  };
  assertEquals(
    await evaluateEnterprise({
      manifest,
      comparison: passingEnterpriseComparison,
    }),
    ["ui_paper: enterprise runtime manifest rejects capture"],
  );
  const blocked = {
    ...emptyEnterpriseManifest,
    coverage: { failed: 0, blocked: 1, missing: [] },
  };
  assertEquals(
    await evaluateEnterprise({
      manifest: blocked,
      comparison: passingEnterpriseComparison,
    }),
    ["ui_paper: enterprise runtime manifest rejects capture"],
  );
});

Deno.test("evaluateArtifacts denies a missing enterprise artifact and a lane omitting the enterprise declaration", async () => {
  assertEquals(
    await evaluateEnterprise({
      manifest: emptyEnterpriseManifest,
      comparison: undefined,
    }),
    [
      "ui_paper: artifact artifacts/ui-baseline/enterprise/paper/comparison.json missing or digest mismatch",
    ],
  );
  // Evidence that declares only the auth pair against the full policy.
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    await writeArtifactFixture(
      evidenceDir,
      artifactDir,
      runtimeManifestPolicy,
      JSON.stringify(passingRuntimeManifest),
    );
    assertEquals(
      await evaluateArtifacts(evidenceDir, artifactDir, [fullLane]),
      ["ui_paper: artifact declaration mismatch"],
    );
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies a no-artifact lane that declares a list", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  const noArtifactLane: LanePolicy = {
    lane: "rails",
    job: "fast / backend rails",
    artifacts: [],
  };
  try {
    await Deno.writeTextFile(
      `${evidenceDir}/rails.txt`,
      `artifacts=some/unexpected/path.json:${"a".repeat(64)}\n`,
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      noArtifactLane,
    ]);
    assertEquals(failures, ["rails: artifact declaration mismatch"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("evaluateArtifacts denies a declaration carrying an extra path", async () => {
  const evidenceDir = await Deno.makeTempDir();
  const artifactDir = await Deno.makeTempDir();
  try {
    const path = runtimeManifestPolicy.artifacts[0].path;
    const fullPath = `${artifactDir}/${path}`;
    await Deno.mkdir(fullPath.slice(0, fullPath.lastIndexOf("/")), {
      recursive: true,
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify(passingRuntimeManifest),
    );
    await Deno.writeFile(fullPath, bytes);
    const digest = await sha256Hex(bytes);
    await Deno.writeTextFile(
      `${evidenceDir}/ui_capture.txt`,
      `artifacts=${path}:${digest},extra/unexpected.json:${"b".repeat(64)}\n`,
    );
    const failures = await evaluateArtifacts(evidenceDir, artifactDir, [
      runtimeManifestPolicy,
    ]);
    assertEquals(failures, ["ui_capture: artifact declaration mismatch"]);
  } finally {
    await Deno.remove(evidenceDir, { recursive: true });
    await Deno.remove(artifactDir, { recursive: true });
  }
});

Deno.test("CI handoff preserves policy artifacts and transfers them portably", async () => {
  const policy = parsePolicy(
    await Deno.readTextFile("scripts/ci/required-checks.json"),
  );
  const artifactLanes = policy.lanes.filter((lane) => lane.artifacts.length);
  assertEquals(artifactLanes.map((lane) => lane.lane), ["ui_paper_runtime"]);
  const ciWorkflow = await readWorkflow("ci.yml");
  const uiPaperStep = ciWorkflow.match(
    /- name: Write ui_paper_runtime evidence[\s\S]*?run: deno run [^\n]*write-evidence\.ts ui_paper_runtime [^\n]*/,
  );
  assert(uiPaperStep, "ui_paper_runtime evidence step not found");
  const declared = uiPaperStep[0].trim().split(" ").at(-1);
  assertEquals(
    declared,
    artifactLanes[0].artifacts.map((artifact) => artifact.path).join(","),
  );
  assert(!ciWorkflow.includes("actions/upload-artifact@"));
  assert(ciWorkflow.includes("scripts/ci/release-evidence.ts emit-log"));
  assert(!ciWorkflow.includes("actions/download-artifact@"));
  const evidenceJobBlocks = ciWorkflow
    .split(/\n(?=[ ]{2}[a-z][a-z0-9_]*:\n)/)
    .filter((block) => block.includes("write-evidence.ts"));
  assertEquals(evidenceJobBlocks.length, expectedLaneOrder.length);
  for (const lane of expectedLaneOrder) {
    const matches = evidenceJobBlocks.filter((block) =>
      block.includes(`write-evidence.ts ${lane} `)
    );
    assertEquals(matches.length, 1, `expected one evidence job for ${lane}`);
  }
  const uiPaperFailureSummary = ciWorkflow.match(
    /- name: Summarize failure[\s\S]*?tail -n 40 "\$RUNNER_TEMP\/web-dev\.log" \|\| true/,
  );
  assert(uiPaperFailureSummary, "ui_paper failure summary step not found");
  const summary = uiPaperFailureSummary[0];
  assert(summary.includes("if: failure()"));
  assert(summary.includes(
    'jq -c \'.cases[] | select(.kind == "route" and (.status != "passed" or .contentBox == null)) | {id, status, reason, observed: .description.observed}\' artifacts/ui-baseline/runtime/manifest.json',
  ));
  assert(summary.includes(
    "grep -vE '^PASSED ' artifacts/ui-baseline/paper/comparison.txt",
  ));
  assert(summary.includes(
    'tail -n 40 "$RUNNER_TEMP/web-dev.log" || true',
  ));
  assert(!summary.includes("HANDOFF_DIR"));
  assert(!summary.includes("cp -r"));
  assert(!summary.includes("Failure diagnostics:"));
  assert(!ciWorkflow.includes("RUNNER_TEMP/diagnostics/"));
  assert(!ciWorkflow.includes("HANDOFF_DIR/diagnostics/"));
  assert(!ciWorkflow.includes("Failure diagnostics:"));
});

function extractRunBlocks(workflow: string): string[] {
  const lines = workflow.split("\n");
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // A `run:` step is either an unnamed list item (`- run: ...`) or the
    // dashless `run:` key of a named step (`- name: ...` / `- uses: ...`
    // above it, `run:` at the step's own mapping indent below). Both
    // shapes must be matched or a named step's install is invisible to
    // this guard while it happens to comply, checking nothing.
    const match = lines[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
    if (!match) continue;
    const stepIndent = match[1].length;
    const inline = match[2].trim();
    // A bare block-scalar marker (>, >-, |, |-, |+) carries no inline text
    // of its own; the command lives entirely in the indented lines below.
    const parts = /^[|>][+-]?$/.test(inline) ? [] : [inline];
    let j = i + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() === "") {
        j++;
        continue;
      }
      const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
      if (indent <= stepIndent) break;
      parts.push(line.trim());
      j++;
    }
    blocks.push(parts.join(" ").trim());
  }
  return blocks;
}

Deno.test("every pnpm install across .github/workflows/ carries --ignore-pnpmfile", async () => {
  let installBlockCount = 0;
  for await (const entry of Deno.readDir(".github/workflows")) {
    if (!entry.isFile) continue;
    const workflow = await Deno.readTextFile(`.github/workflows/${entry.name}`);
    // Each `run:` step's full logical command is joined into one block
    // first (folding YAML `>`/`|` continuations and any line the step
    // spans), so an install command split across lines cannot slip past a
    // line-scoped substring check.
    const blocks = extractRunBlocks(workflow);

    // Self-check (astra): if extractRunBlocks ever under-extracts (misses
    // a run: step shape), the loop below would silently check nothing for
    // it and this guard would pass while verifying nothing. Cross-check
    // the extracted occurrence count against a raw substring scan of the
    // same file so under-extraction fails loudly instead of passing quiet.
    const blockOccurrences = blocks.reduce(
      (total, block) => total + (block.split("pnpm install").length - 1),
      0,
    );
    const rawOccurrences = workflow.split("pnpm install").length - 1;
    assertEquals(
      blockOccurrences,
      rawOccurrences,
      `${entry.name}: extractRunBlocks found ${blockOccurrences} "pnpm install" occurrence(s) but a raw scan of the file found ${rawOccurrences} — a run: step shape is not being extracted`,
    );

    for (const block of blocks) {
      if (!block.includes("pnpm install")) continue;
      installBlockCount++;
      assert(
        block.includes("--ignore-pnpmfile"),
        `${entry.name}: pnpm install missing --ignore-pnpmfile: ${block}`,
      );
    }
  }
  assert(
    installBlockCount > 0,
    "no pnpm install commands found under .github/workflows/",
  );
});

const forbiddenArtifactActions = /actions\/(?:upload|download)-artifact/i;
const artifactApiPath = /\bactions\/artifacts\b/;

async function assertArtifactWorkflowPolicy(root: string): Promise<void> {
  for await (const entry of Deno.readDir(root)) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory) {
      await assertArtifactWorkflowPolicy(path);
      continue;
    }
    if (!entry.isFile) continue;
    const content = await Deno.readTextFile(path);
    assert(
      !forbiddenArtifactActions.test(content),
      `${path} contains a forbidden Actions artifact transport`,
    );
    assertWorkflowArtifactTransportPolicy(path, content);
    assert(
      !artifactApiPath.test(content),
      `${path} uses the Actions Artifacts API`,
    );
  }
}

Deno.test(
  "every workflow rejects Actions artifact transport and API access",
  async () => {
    await assertArtifactWorkflowPolicy(".github/workflows");

    const fixture = await Deno.makeTempDir();
    const fixtureWorkflow = (body: string) =>
      `name: fixture
on: push
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
${body}
`;
    try {
      await Deno.writeTextFile(
        `${fixture}/reintroduced.yml`,
        fixtureWorkflow("      - uses: actions/upload-artifact@deadbeef"),
      );
      await assertRejects(
        () => assertArtifactWorkflowPolicy(fixture),
        Error,
        "forbidden Actions artifact transport",
      );
      await Deno.writeTextFile(
        `${fixture}/reintroduced.yml`,
        fixtureWorkflow(
          "      - run: echo ok\n      # uses: actions/upload-artifact@v4",
        ),
      );
      await assertRejects(
        () => assertArtifactWorkflowPolicy(fixture),
        Error,
        "forbidden Actions artifact transport",
      );
      await Deno.writeTextFile(
        `${fixture}/reintroduced.yml`,
        fixtureWorkflow(
          "      - run: echo ok\n      # uses: actions/upload-artifactLegacy",
        ),
      );
      await assertRejects(
        () => assertArtifactWorkflowPolicy(fixture),
        Error,
        "forbidden Actions artifact transport",
      );
      await Deno.writeTextFile(
        `${fixture}/reintroduced.yml`,
        fixtureWorkflow(
          "      - run: gh api repos/example/repo/actions/artifacts",
        ),
      );
      await assertRejects(
        () => assertArtifactWorkflowPolicy(fixture),
        Error,
        "uses the Actions Artifacts API",
      );
      await Deno.writeTextFile(
        `${fixture}/reintroduced.yml`,
        fixtureWorkflow("      - run: echo ok"),
      );
      await assertArtifactWorkflowPolicy(fixture);
    } finally {
      await Deno.remove(fixture, { recursive: true });
    }
  },
);

Deno.test("storybook browser lane serves on a free port, not 6006", async () => {
  const workflow = await readWorkflow("ci.yml");
  const [, jobsBlock] = workflow.split(/^jobs:\n/m);
  const body = workflowJob(jobsBlock, "ui_storybook_browser");
  assert(!body.includes("6006"), "no fixed 6006 in the lane");
  const pick = body.indexOf("- name: Pick a free Storybook port");
  assert(pick >= 0, "port step exists");
  assert(body.includes('listen(0,"127.0.0.1"'), "port step listens on 0");
  assert(
    body.includes('echo "STORYBOOK_PORT=$port" >> "$GITHUB_ENV"'),
    "port exported to GITHUB_ENV",
  );
  const serve = body.indexOf('--port "$STORYBOOK_PORT"');
  assert(serve > pick, "serve uses the picked port after the pick step");
  const readiness = body.split(
    'curl -fsS "http://127.0.0.1:$STORYBOOK_PORT/index.json"',
  ).length - 1;
  assert(readiness >= 2, "both readiness curls use the picked port");
  const owner = body.indexOf(
    'kill -0 "$(cat "$RUNNER_TEMP/storybook-static.pid")"',
  );
  assert(owner > serve, "ownership check follows serve");
  assert(
    body.includes("BASE_URL: http://127.0.0.1:${{ env.STORYBOOK_PORT }}"),
    "BASE_URL derives from the picked port",
  );
  const run = body.indexOf(
    "run: node scripts/ci/run-browser-checks.mjs storybook",
  );
  assert(run > owner, "browser checks run after the ownership check");
  const evidence = body.slice(
    body.indexOf("- name: Write ui_storybook_browser evidence"),
  );
  assert(evidence.includes("if: always()"), "evidence step always runs");
  assert(
    evidence.includes("BASE_URL=http://127.0.0.1:$STORYBOOK_PORT"),
    "evidence records the real port",
  );
});
