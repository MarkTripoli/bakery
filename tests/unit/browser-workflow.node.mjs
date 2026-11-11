import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { classifyNameStatusZ } from "../../scripts/ci/classify-changes.ts";
import { browserCommands } from "../../scripts/ci/browser-plan.mjs";
import { readBrowserSelection } from "../../scripts/ci/browser-selection.mjs";

const shardJobs = [
  "ui_paper_runtime",
  "ui_paper_entitlements",
  "ui_paper_artifacts",
];

test("workflow schedules full coverage and aggregate requires consumer job success", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const policy = JSON.parse(
    readFileSync("scripts/ci/required-checks.json", "utf8"),
  );
  assert.equal(workflow.on.schedule.length, 1);
  assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  assert.match(
    workflow.env.BAKERY_BROWSER_COVERAGE,
    /schedule.*workflow_dispatch.*'full'.*'affected'/,
  );
  for (
    const [jobId, lane] of [
      ["ui_web", "web"],
      ["ui_web_b", "web"],
      [
        "ui_web_c",
        "web",
      ],
      ["ui_web_d", "web"],
      [
        "ui_storybook_browser",
        "storybook",
      ],
    ]
  ) {
    const job = workflow.jobs[jobId];
    assert.ok(workflow.jobs.aggregate.needs.includes(jobId));
    assert.ok(
      job.steps.some((step) =>
        step.run === `node scripts/ci/run-browser-checks.mjs ${lane}`
      ),
    );
    assert.ok(
      job.steps.find((step) => step.uses?.startsWith("actions/checkout@"))
        .with["fetch-depth"] === 0,
    );
  }
  const aggregate = workflow.jobs.aggregate.steps.find((step) =>
    step.name === "Reject invalid direct lane results"
  );
  assert.match(aggregate.run, /"\$LANE_UI_WEB_BROWSER"/);
  for (const suffix of ["B", "C", "D"]) {
    assert.match(
      aggregate.run,
      new RegExp(`"\\$LANE_UI_WEB_BROWSER_${suffix}"`),
    );
    assert.equal(
      aggregate.env[`LANE_UI_WEB_BROWSER_${suffix}`],
      `\${{ needs.ui_web_${suffix.toLowerCase()}.result }}`,
    );
  }
  assert.match(aggregate.run, /lane_result" != success/);
  assert.equal(aggregate.env.LANE_UI_WEB_BROWSER, "${{ needs.ui_web.result }}");
  assert.equal(
    policy.lanes.find((lane) => lane.lane === "ui_web_browser").job,
    workflow.jobs.ui_web.name,
  );

  for (const job of shardJobs) {
    const captures = workflow.jobs[job].steps.filter((step) =>
      step.name === "Capture owned matrices"
    );
    assert.equal(captures.length, 1, `${job} capture step`);
    assert.equal(captures[0].env.BAKERY_CAPTURE_JOBS, "4");
    assert.match(captures[0].run, /--\$mode/);
  }
});

test("schedule/manual empty diff reaches full consumers and fail-closed aggregate", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const aggregate = workflow.jobs.aggregate.steps.find((step) =>
    step.name === "Reject invalid direct lane results"
  );
  for (const eventName of ["schedule", "workflow_dispatch"]) {
    const context = {
      github: {
        event_name: eventName,
        sha: "a".repeat(40),
        event: { pull_request: { base: {}, head: {} } },
      },
      needs: Object.fromEntries(
        workflow.jobs.aggregate.needs.map((
          job,
        ) => [job, { result: "success" }]),
      ),
    };
    const evaluate = (expression) =>
      runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ""), context);
    const classifier = workflow.jobs.changes.steps.find((step) =>
      step.id === "classify"
    );
    assert.equal(evaluate(classifier.env.BASE_SHA), context.github.sha);
    assert.equal(evaluate(classifier.env.HEAD_SHA), context.github.sha);
    const route = classifyNameStatusZ("");
    assert.equal(route, "full");
    context.needs.changes.outputs = { route };
    const coverage = evaluate(workflow.env.BAKERY_BROWSER_COVERAGE);
    assert.equal(coverage, "full");
    const selection = readBrowserSelection({
      BAKERY_BROWSER_COVERAGE: coverage,
    });
    assert.equal(browserCommands("web", selection)[0].mode, "full");
    assert.equal(browserCommands("storybook", selection)[0].mode, "full");
    for (
      const job of [
        "ui_web",
        "ui_web_b",
        "ui_web_c",
        "ui_web_d",
        "ui_storybook_browser",
        "ui_paper_runtime",
        "ui_paper_entitlements",
        "ui_paper_artifacts",
      ]
    ) {
      assert.equal(
        evaluate(workflow.jobs[job].if),
        true,
        `${eventName}/${job}`,
      );
    }
    // The shards' capture/compare steps have no per-step if: the job-level
    // if above gates the whole shard on the full route.
    for (const job of shardJobs) {
      assert(
        workflow.jobs[job].steps.some((step) =>
          step.name === "Capture owned matrices"
        ),
        `${job} has a capture step`,
      );
    }
    const env = Object.fromEntries(
      Object.keys(aggregate.env).map((
        name,
      ) => [name, name === "ROUTE" ? route : "success"]),
    );
    const result = spawnSync("bash", ["-c", aggregate.run], {
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    for (
      const name of [
        "LANE_UI_WEB_BROWSER",
        "LANE_UI_STORYBOOK_BROWSER",
        "LANE_UI_PAPER_RUNTIME",
        "LANE_UI_PAPER_ENTITLEMENTS",
        "LANE_UI_PAPER_ARTIFACTS",
      ]
    ) {
      const refused = spawnSync("bash", ["-c", aggregate.run], {
        env: { ...env, [name]: "skipped" },
        encoding: "utf8",
      });
      assert.equal(
        refused.status,
        1,
        `${eventName}/${name} must not count skipped coverage as success`,
      );
    }
  }
});

test("the affected route selects exactly the classified heavy lanes", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const aggregate = workflow.jobs.aggregate.steps.find((step) =>
    step.name === "Reject invalid direct lane results"
  );
  assert.ok(
    aggregate.env.AFFECTED_LANES === "${{ needs.changes.outputs.lanes }}",
  );
  const heavyLanes = [
    "integration_tests",
    "security_tests",
    "recovery_tests",
    "browser_tests",
    "ui_web_browser",
    "ui_web_browser_b",
    "ui_web_browser_c",
    "ui_web_browser_d",
    "e2e_tests",
    "ui_architecture",
    "ui_storybook_browser",
    "ui_paper_runtime",
    "ui_paper_entitlements",
    "ui_paper_artifacts",
    "native_worker",
  ];
  const selected = [
    "ui_web_browser",
    "ui_web_browser_b",
    "ui_web_browser_c",
    "ui_web_browser_d",
    "ui_storybook_browser",
    "ui_paper_runtime",
  ];
  const env = { ROUTE: "affected", AFFECTED_LANES: JSON.stringify(selected) };
  for (const key of Object.keys(aggregate.env)) {
    if (key === "ROUTE" || key === "AFFECTED_LANES") continue;
    const laneName = key.slice(5).toLowerCase();
    env[key] = heavyLanes.includes(laneName) && !selected.includes(laneName)
      ? "skipped"
      : "success";
  }
  env.LANE_DOCS_VALIDATION = "skipped";
  const pass = spawnSync("bash", ["-c", aggregate.run], {
    env,
    encoding: "utf8",
  });
  assert.equal(pass.status, 0, pass.stderr);
  // A selected lane that did not succeed rejects.
  const failed = { ...env, LANE_UI_PAPER_RUNTIME: "failure" };
  assert.equal(
    spawnSync("bash", ["-c", aggregate.run], { env: failed, encoding: "utf8" })
      .status,
    1,
  );
  // A selected lane that was skipped rejects just as hard.
  const skippedSelected = { ...env, LANE_UI_WEB_BROWSER: "skipped" };
  assert.equal(
    spawnSync("bash", ["-c", aggregate.run], {
      env: skippedSelected,
      encoding: "utf8",
    }).status,
    1,
  );
  // An unselected heavy lane that still ran rejects (fail-closed gap check).
  const overshot = { ...env, LANE_RECOVERY_TESTS: "success" };
  assert.equal(
    spawnSync("bash", ["-c", aggregate.run], {
      env: overshot,
      encoding: "utf8",
    })
      .status,
    1,
  );
  // The full branch never fires on the affected route: an affected run whose
  // unselected lanes are skipped is accepted even though the full branch
  // would demand their success.
  assert.ok(!aggregate.run.includes('ROUTE == gate && "$AFFECTED_LANES"'));
});

test("affectedLanes classifies push paths and falls back to full", async () => {
  const { affectedLanes, routeForEvent } = await import(
    "../../scripts/ci/classify-changes.ts"
  );
  assert.deepEqual(
    affectedLanes([{ status: "M", paths: ["apps/worker/src/main.ts"] }]),
    [
      "integration_tests",
      "security_tests",
      "recovery_tests",
      "e2e_tests",
      "native_worker",
    ],
  );
  assert.deepEqual(
    affectedLanes([{ status: "M", paths: ["tests/unit/x.ts"] }]),
    [],
  );
  assert.equal(affectedLanes([]), null);
  assert.equal(routeForEvent("affected", "push"), "affected");
  assert.equal(routeForEvent("affected", "schedule"), "full");
});

test("main pushes cap the web oracle while nightly and manual stay exhaustive", () => {
  const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
  const step = workflow.jobs.ui_web.steps.find((step) =>
    step.name === "Run required core and affected web consumers"
  );
  assert.ok(step, "ui_web must run the browser checks step");
  for (
    const [eventName, expected] of [
      ["push", "core"],
      ["schedule", "unlimited"],
      ["workflow_dispatch", "unlimited"],
    ]
  ) {
    const evaluated = step.env.BAKERY_BROWSER_MAX_MODE.replace(
      /^\$\{\{\s*|\s*\}\}$/g,
      "",
    );
    assert.equal(
      runInNewContext(evaluated, { github: { event_name: eventName } }),
      expected,
      eventName,
    );
  }
  const selection = readBrowserSelection({
    BAKERY_BROWSER_COVERAGE: "affected",
    BAKERY_BROWSER_MAX_MODE: "core",
  });
  const commands = browserCommands("web", selection);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].mode, "core");
  const nightly = readBrowserSelection({ BAKERY_BROWSER_COVERAGE: "full" });
  assert.equal(browserCommands("web", nightly)[0].mode, "full");
});
