import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  affectedLanes,
  classifyChanges,
  classifyNameStatusZ,
  parseNameStatusZ,
  routeForEvent,
} from "../../scripts/ci/classify-changes.ts";

const entry = (status: string, ...paths: string[]) => ({ status, paths });

Deno.test("routes an all-documentation diff to the docs lane", () => {
  assertEquals(
    classifyChanges([
      entry("M", "docs/guide.md"),
      entry("A", "learnings/new.xml"),
    ]),
    "docs",
  );
});

Deno.test("routes mixed, executable, workflow, and unknown paths to full CI", () => {
  for (
    const entries of [
      [entry("M", "docs/guide.md"), entry("M", "apps/web/src/main.tsx")],
      [entry("M", "docs/technical-design/example.ts")],
      [entry("M", ".github/workflows/ci.yml")],
      [entry("M", "docs/guide.csv")],
    ]
  ) assertEquals(classifyChanges(entries), "full");
});

Deno.test("renames require both old and new paths to be allowed", () => {
  assertEquals(
    classifyChanges([entry("R100", "docs/old.md", "docs/new.md")]),
    "docs",
  );
  assertEquals(
    classifyChanges([entry("R100", "docs/old.md", "scripts/new.ts")]),
    "full",
  );
});

Deno.test("a pull request runs the gate and post-merge events run everything", () => {
  // The whole point of the split: a pull request gets a bounded answer, the
  // heavy evidence lanes are post-merge only. Docs-only diffs keep their lane
  // on every event, including pull requests.
  assertEquals(routeForEvent("full", "pull_request"), "gate");
  assertEquals(routeForEvent("full", "push"), "full");
  assertEquals(routeForEvent("full", "schedule"), "full");
  assertEquals(routeForEvent("full", "workflow_dispatch"), "full");
  assertEquals(routeForEvent("full", undefined), "full");
  for (const event of ["pull_request", "push", "schedule", undefined]) {
    assertEquals(routeForEvent("docs", event), "docs");
  }
});

Deno.test("the live aggregate admits docs and keeps full lanes fail-closed", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/ci.yml");
  assertStringIncludes(workflow, 'if [[ "$ROUTE" == docs ]]; then');
  assertStringIncludes(
    workflow,
    '[[ "$LANE_DOCS_VALIDATION" == success ]]',
  );
  assertStringIncludes(
    workflow,
    '[[ "$ROUTE" == full ]] || { echo "unknown CI route: $ROUTE"',
  );
  assertStringIncludes(
    workflow,
    'echo "required lane did not succeed: $lane_result"',
  );
  assert(workflow.includes("name: required / full-stack aggregate"));
  assertStringIncludes(workflow, 'if [[ "$ROUTE" == gate ]]; then');
  assertStringIncludes(
    workflow,
    'echo "gate lane did not succeed: $lane_result"',
  );
  assertStringIncludes(
    workflow,
    'echo "post-merge lane ran on a pull request: $heavy_lane"',
  );
});

Deno.test("deletes and malformed or empty diffs fail closed", () => {
  assertEquals(classifyChanges([entry("D", "docs/removed.md")]), "docs");
  assertEquals(classifyNameStatusZ(""), "full");
  assertEquals(classifyNameStatusZ("M\0docs/guide.md\0broken"), "full");
  assertEquals(parseNameStatusZ("R100\0docs/old.md\0docs/new.md\0"), [
    entry("R100", "docs/old.md", "docs/new.md"),
  ]);
});

// Every rule row must produce the lanes it advertises, so a lane rename in
// required-checks.json surfaces here instead of silently routing to nothing.
Deno.test("affectedLanes maps each table row to its heavy lanes", () => {
  assertEquals(
    affectedLanes([
      entry("M", "apps/server/src/modules/agent/migrations/0001_foo.ts"),
    ]),
    [
      "integration_tests",
      "recovery_tests",
      "e2e_tests",
    ],
  );
  assertEquals(affectedLanes([entry("M", "apps/server/src/config.ts")]), [
    "integration_tests",
    "security_tests",
    "recovery_tests",
    "e2e_tests",
    "browser_tests",
    "ui_web_browser",
    "ui_web_browser_b",
    "ui_web_browser_c",
    "ui_web_browser_d",
  ]);
  assertEquals(affectedLanes([entry("M", "apps/worker/src/main.ts")]), [
    "integration_tests",
    "security_tests",
    "recovery_tests",
    "e2e_tests",
    "native_worker",
  ]);
  assertEquals(affectedLanes([entry("M", "apps/web/src/main.tsx")]), [
    "browser_tests",
    "ui_web_browser",
    "ui_web_browser_b",
    "ui_web_browser_c",
    "ui_web_browser_d",
    "ui_catalog",
    "ui_quality",
    "ui_architecture",
    "ui_storybook_browser",
    "ui_paper_runtime",
    "ui_paper_entitlements",
    "ui_paper_artifacts",
  ]);
  assertEquals(affectedLanes([entry("M", "packages/ui/src/button.tsx")]), [
    "ui_catalog",
    "ui_quality",
    "ui_architecture",
    "ui_storybook_browser",
    "ui_paper_runtime",
    "ui_paper_entitlements",
    "ui_paper_artifacts",
  ]);
  assertEquals(affectedLanes([entry("M", "packages/contracts/src/user.ts")]), [
    "contract_description_gate",
    "contract_description_gate_b",
    "contract_description_gate_c",
    "integration_tests",
    "security_tests",
    "e2e_tests",
  ]);
  assertEquals(
    affectedLanes([entry("M", "packages/integration-sdk/src/manifest.ts")]),
    [
      "contract_description_gate",
      "contract_description_gate_b",
      "contract_description_gate_c",
      "integration_tests",
      "security_tests",
      "recovery_tests",
      "e2e_tests",
      "browser_tests",
      "ui_web_browser",
      "ui_web_browser_b",
      "ui_web_browser_c",
      "ui_web_browser_d",
    ],
  );
  assertEquals(affectedLanes([entry("M", "packages/persistence/src/db.ts")]), [
    "integration_tests",
    "security_tests",
    "recovery_tests",
  ]);
  assertEquals(affectedLanes([entry("M", "packages/i18n/src/en.json")]), [
    "browser_tests",
    "ui_web_browser",
    "ui_web_browser_b",
    "ui_web_browser_c",
    "ui_web_browser_d",
  ]);
  assertEquals(
    affectedLanes([entry("M", "tests/browser/web_shell_spec.ts")]),
    ["browser_tests"],
  );
  assertEquals(
    affectedLanes([entry("M", "tests/integration/a_test.ts")]),
    ["integration_tests"],
  );
  assertEquals(
    affectedLanes([entry("M", "tests/security/x_test.ts")]),
    ["security_tests"],
  );
  assertEquals(
    affectedLanes([entry("M", "tests/recovery/y_test.ts")]),
    ["recovery_tests"],
  );
  assertEquals(affectedLanes([entry("M", "tests/e2e/z_test.ts")]), [
    "e2e_tests",
    "integration_tests",
    "security_tests",
  ]);
  assertEquals(
    affectedLanes([entry("M", "tests/native/worker_test.ts")]),
    ["native_worker"],
  );
  assertEquals(affectedLanes([entry("M", "tests/contract/a_test.ts")]), [
    "contract_description_gate",
    "contract_description_gate_b",
    "contract_description_gate_c",
  ]);
  assertEquals(affectedLanes([entry("M", "tests/rails/rail_test.ts")]), [
    "rails",
  ]);
  assertEquals(affectedLanes([entry("M", "tests/unit/ci_test.ts")]), []);
  assertEquals(
    affectedLanes([entry("M", "tests/provider/conformance_test.ts")]),
    [],
  );
  assertEquals(
    affectedLanes([entry("M", "tests/compatibility/v1_test.ts")]),
    ["integration_tests"],
  );
  assertEquals(affectedLanes([entry("M", "tests/connected/a_test.ts")]), [
    "e2e_tests",
    "browser_tests",
    "ui_web_browser",
    "ui_web_browser_b",
    "ui_web_browser_c",
    "ui_web_browser_d",
    "integration_tests",
    "security_tests",
  ]);
  assertEquals(affectedLanes([entry("M", "tests/r2/object_test.ts")]), [
    "integration_tests",
    "recovery_tests",
  ]);
});

Deno.test("the migration subtree wins over the broader apps/server row", () => {
  assertEquals(
    affectedLanes([
      entry("M", "apps/server/src/modules/agent/migrations/a.ts"),
    ]),
    [
      "integration_tests",
      "recovery_tests",
      "e2e_tests",
    ],
  );
  assert(
    affectedLanes([entry("M", "apps/server/src/config.ts")])!.includes(
      "browser_tests",
    ),
  );
});

Deno.test("multiple changed files union their lanes", () => {
  assertEquals(
    affectedLanes([
      entry("M", "packages/i18n/src/en.json"),
      entry("M", "tests/recovery/startup_test.ts"),
    ]),
    [
      "browser_tests",
      "ui_web_browser",
      "ui_web_browser_b",
      "ui_web_browser_c",
      "ui_web_browser_d",
      "recovery_tests",
    ],
  );
});

Deno.test("unknown, infra, fixture, helper, baseline and manifest paths fall back to full", () => {
  for (
    const path of [
      "apps/mobile/src/app.ts",
      "packages/unknown thing",
      "src/main.ts",
      "README.md",
      "tests/fixtures/db.ts",
      "tests/helpers/run.ts",
      "scripts/ci/classify-changes.ts",
      "scripts/build.ts",
      ".github/workflows/ci.yml",
      "infra/main.tf",
      "packages/config/deno.json",
      "packages/ui/storybook.config.ts",
      "packages/ui/storybook-static/index.html",
      "docs/technical-design/ui-baselines/web-shell.png",
      "deno.lock",
      "deno.json",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "docs/guide.csv",
    ]
  ) assertEquals(affectedLanes([entry("M", path)]), null, path);
});

Deno.test("allowed documentation paths ride along without selecting lanes", () => {
  assertEquals(
    affectedLanes([
      entry("M", "docs/guide.md"),
      entry("M", "apps/web/src/main.tsx"),
    ]),
    affectedLanes([entry("M", "apps/web/src/main.tsx")]),
  );
});

Deno.test("the worker bootstrap package is classified and selects no heavy lane", () => {
  // An unmapped path is unknown and forces the full route; this package's
  // tests are unit tests, which the fast lanes run on every change.
  assertEquals(
    affectedLanes([entry("M", "packages/worker-bootstrap/src/install.ts")]),
    [],
  );
});

Deno.test("affected route depends on the event like the other routes", () => {
  assertEquals(routeForEvent("affected", "push"), "affected");
  assertEquals(routeForEvent("affected", "schedule"), "full");
  assertEquals(routeForEvent("affected", "workflow_dispatch"), "full");
  assertEquals(routeForEvent("affected", "pull_request"), "gate");
  assertEquals(routeForEvent("affected", undefined), "full");
  assertEquals(affectedLanes([]), null);
});

Deno.test("the workflow routes affected pushes through the lane union", async () => {
  const workflow = await Deno.readTextFile(".github/workflows/ci.yml");
  assertStringIncludes(
    workflow,
    "      lanes: ${{ steps.classify.outputs.lanes }}",
  );
  assertStringIncludes(
    workflow,
    'AFFECTED_LANES: "${{ needs.changes.outputs.lanes }}"',
  );
  assertStringIncludes(
    workflow,
    'echo "affected lane did not succeed: ${lane_key} ($lane_result)"',
  );
  assertStringIncludes(
    workflow,
    'echo "unselected lane ran on the affected route: ${lane_key} ($lane_result)"',
  );
  assertStringIncludes(
    workflow,
    'if [[ "$LANE_DOCS_VALIDATION" != skipped ]]; then',
  );
  // Every heavy lane's `if` admits the affected route exactly through its own
  // lane key (mirroring required-checks.json lane keys), and the parity
  // shards keep their existing prerequisite needs guards.
  const jobLineByKey: [string, string][] = [
    ["integration", "integration_tests"],
    ["security", "security_tests"],
    ["recovery", "recovery_tests"],
    ["browser", "browser_tests"],
    ["e2e", "e2e_tests"],
    ["ui_architecture", "ui_architecture"],
    ["ui_storybook_browser", "ui_storybook_browser"],
    ["ui_web", "ui_web_browser"],
    ["ui_web_b", "ui_web_browser_b"],
    ["ui_web_c", "ui_web_browser_c"],
    ["ui_web_d", "ui_web_browser_d"],
    ["ui_paper_runtime", "ui_paper_runtime"],
    ["ui_paper_entitlements", "ui_paper_entitlements"],
    ["ui_paper_artifacts", "ui_paper_artifacts"],
    ["native_worker", "native_worker"],
  ];
  for (const [jobId, laneKey] of jobLineByKey) {
    const start = workflow.indexOf(`${jobId}:\n`);
    assert(start > 0, `${jobId} job exists`);
    const nextJob = workflow.slice(start + 1).match(/^(?: {2})?\S+:\n$/m);
    let block: string;
    if (nextJob?.index !== undefined) {
      block = workflow.slice(start, start + 1 + nextJob.index);
    } else {
      block = workflow.slice(start);
    }
    assertStringIncludes(
      block,
      `needs.changes.outputs.route == 'affected' && contains(fromJSON(needs.changes.outputs.lanes), '${laneKey}')`,
      `${jobId}: ${laneKey}`,
    );
  }
  for (
    const shard of [
      "ui_paper_runtime",
      "ui_paper_entitlements",
      "ui_paper_artifacts",
    ]
  ) {
    const job = workflow.slice(workflow.indexOf(`  ${shard}:`));
    assertStringIncludes(job, "needs.ui_catalog.result == 'success'");
    assertStringIncludes(job, "needs.ui_quality.result == 'success'");
    assertStringIncludes(job, "needs.ui_storybook_browser.result == 'success'");
  }
});
