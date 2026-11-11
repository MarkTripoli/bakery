import assert from "node:assert/strict";
import test from "node:test";
import BrowserCoreReporter from "../../apps/web/tests/helpers/browser-core-reporter.ts";
import {
  browserCore,
  coreCoverageIssues,
  coreGrep,
  coreListingIssues,
} from "../../scripts/ci/browser-core.mjs";
import {
  browserCommands,
  readBrowserShard,
} from "../../scripts/ci/browser-plan.mjs";
import {
  readBrowserSelection,
  retainExistingConsumers,
  selectBrowserChecks,
} from "../../scripts/ci/browser-selection.mjs";
const change = (status, ...paths) => ({ status, paths });
const modified = (paths) =>
  selectBrowserChecks(paths.map((path) => change("M", path)));

test("task page changes retain whole composed consumers", () => {
  const selection = modified(["apps/web/src/pages/TaskRunControls.tsx"]);
  assert.equal(selection.full, false);
  assert.deepEqual(selection.webSpecs, [
    "artifact-retrieval.spec.ts",
    "task-composer.spec.ts",
    "tasks.spec.ts",
  ]);
});

test("TaskSessionView changes retain mounted WorkSessionFixture shell coverage", () => {
  for (
    const path of [
      "apps/web/src/pages/task-session-view.tsx",
      "apps/web/src/pages/TasksPage.tsx",
    ]
  ) {
    const selection = modified([path]);
    assert.ok(
      selection.webSpecs.includes("shell.spec.ts"),
      "mounted WorkFixture consumer must be selected",
    );
    assert.equal(selection.full, false);
  }
  assert.equal(
    coreGrep("desktop").test(
      "desktop shell.spec.ts manifest route matrix mounted work/session",
    ),
    false,
  );
});

test("E05 RunOutputPanel changes select all application and Storybook consumers", () => {
  const selection = modified(["packages/ui/src/organisms/RunOutputPanel.tsx"]);
  assert.equal(selection.full, true);
  assert.equal(selection.storybook, true);
});

test("unknown sources and shared authority always retain exhaustive coverage", () => {
  for (
    const path of [
      "apps/web/src/pages/TaskNewUnknown.tsx",
      "apps/web/src/api/client.ts",
      "apps/web/src/auth/session.ts",
      "apps/server/src/modules/artifacts/operations.ts",
      "packages/ui/src/foundations/theme.css",
      "packages/i18n/src/index.ts",
      "apps/web/tests/helpers/mock-session.ts",
      "apps/web/tests/auth-journey.spec.ts",
      "apps/web/tests/settings-journey.spec.ts",
      "apps/web/playwright.config.ts",
      "docs/technical-design/ui-baselines/runtime-cases.json",
      ".github/workflows/ci.yml",
      "pnpm-lock.yaml",
    ]
  ) assert.equal(modified([path]).full, true, path);
  assert.equal(selectBrowserChecks([]).full, true);
});

test("added specs fall full even when present; existing modified specs stay narrow", () => {
  const added = retainExistingConsumers(
    selectBrowserChecks([change("A", "apps/web/tests/new-consumer.spec.ts")]),
    () => true,
  );
  assert.equal(added.full, true);
  assert.equal(added.storybook, true);
  const existing = retainExistingConsumers(
    selectBrowserChecks([change("M", "apps/web/tests/tasks.spec.ts")]),
    () => true,
  );
  assert.equal(existing.full, false);
  assert.deepEqual(existing.webSpecs, ["tasks.spec.ts"]);
  assert.equal(retainExistingConsumers(existing, () => false).full, true);
});

test("deleted, renamed, copied and unknown-status tests fall full with both paths retained", () => {
  for (
    const entry of [
      change("D", "apps/web/tests/deleted.spec.ts"),
      change("R100", "apps/web/tests/tasks.spec.ts", "docs/moved.md"),
      change("R100", "docs/old.md", "apps/web/tests/new.spec.ts"),
      change(
        "C100",
        "apps/web/tests/tasks.spec.ts",
        "apps/web/tests/copy.spec.ts",
      ),
      change("U", "apps/web/tests/tasks.spec.ts"),
    ]
  ) {
    const selection = selectBrowserChecks([entry]);
    assert.equal(selection.full, true, entry.status);
    assert.equal(selection.storybook, true, entry.status);
  }
});

test("Git reader preserves change status instead of treating added test as modification", () => {
  const env = {
    BAKERY_BROWSER_COVERAGE: "affected",
    BASE_SHA: "a".repeat(40),
    CANDIDATE_SHA: "b".repeat(40),
  };
  const git = (output) => (command, args) => {
    assert.equal(command, "git");
    assert.ok(args.includes("--name-status"));
    assert.ok(args.includes("--find-renames"));
    assert.ok(args.includes("-z"));
    assert.ok(!args.includes("--name-only"));
    return output;
  };
  assert.equal(
    readBrowserSelection(env, git("A\0apps/web/tests/tasks.spec.ts\0")).full,
    true,
  );
  assert.equal(
    readBrowserSelection(env, git("M\0apps/web/tests/tasks.spec.ts\0")).full,
    false,
  );
  assert.equal(
    readBrowserSelection(
      env,
      git("R100\0docs/old.md\0apps/web/tests/new.spec.ts\0"),
    ).full,
    true,
  );
  assert.equal(
    readBrowserSelection(env, git("R100\0apps/web/tests/tasks.spec.ts\0")).full,
    true,
  );
});

test("missing diff SHAs fall broad while explicit full executes broad cases", () => {
  assert.equal(
    readBrowserSelection({ BAKERY_BROWSER_COVERAGE: "affected" }).full,
    true,
  );
  const full = readBrowserSelection({ BAKERY_BROWSER_COVERAGE: "full" });
  assert.equal(full.full, true);
  assert.equal(full.storybook, true);
  assert.throws(() =>
    readBrowserSelection({ BAKERY_BROWSER_COVERAGE: "typo" })
  );
});

test("documentation selects core only without requiring unaffected Storybook", () => {
  const selection = modified(["docs/engineering-rules.md"]);
  assert.equal(selection.full, false);
  assert.equal(selection.storybook, false);
  assert.deepEqual(selection.webSpecs, []);
});

test("full coverage dispatches exhaustive suite with mandatory core verification", () => {
  const selection = readBrowserSelection({ BAKERY_BROWSER_COVERAGE: "full" });
  assert.deepEqual(browserCommands("web", selection), [{
    packageDir: "apps/web",
    mode: "full",
    requireCore: true,
  }]);
  assert.deepEqual(browserCommands("storybook", selection), [{
    packageDir: "packages/ui",
    mode: "full",
    requireCore: false,
  }]);
});

test("narrow selection executes core then distinct affected consumers", () => {
  const selection = modified(["apps/web/src/pages/TaskRunControls.tsx"]);
  assert.deepEqual(
    browserCommands("web", selection).map((
      command,
    ) => [command.mode, command.requireCore]),
    [["core", true], ["affected", false]],
  );
  assert.deepEqual(browserCommands("storybook", selection), []);
});

test("push cap downgrades the unknown-ownership oracle to core consumers", () => {
  const selection = readBrowserSelection({
    BAKERY_BROWSER_COVERAGE: "affected",
    BAKERY_BROWSER_MAX_MODE: "core",
  });
  assert.equal(selection.full, false);
  assert.deepEqual(selection.webSpecs, []);
  assert.match(selection.reason, /capped to core consumers/);
  assert.deepEqual(browserCommands("web", selection), [{
    packageDir: "apps/web",
    mode: "core",
    requireCore: true,
  }]);
});

test("push cap keeps narrow consumer selections and Storybook coverage", () => {
  const env = {
    BAKERY_BROWSER_COVERAGE: "affected",
    BAKERY_BROWSER_MAX_MODE: "core",
    BASE_SHA: "a".repeat(40),
    CANDIDATE_SHA: "b".repeat(40),
  };
  const git = () => () => "M\0apps/web/src/pages/TaskRunControls.tsx\0";
  const capped = readBrowserSelection(env, git());
  assert.equal(capped.full, false);
  assert.deepEqual(capped.webSpecs, [
    "artifact-retrieval.spec.ts",
    "task-composer.spec.ts",
    "tasks.spec.ts",
  ]);
  assert.equal(capped.storybook, false);
  assert.equal(
    capped,
    retainExistingConsumers(capped, () => true),
  );
  const storybook = readBrowserSelection({
    BAKERY_BROWSER_COVERAGE: "full",
    BAKERY_BROWSER_MAX_MODE: "core",
  });
  assert.equal(storybook.storybook, true);
  assert.deepEqual(browserCommands("storybook", storybook), [{
    packageDir: "packages/ui",
    mode: "full",
    requireCore: false,
  }]);
});

const passing = browserCore.map(([project, file, title]) => ({
  project,
  file,
  title,
  outcome: "expected",
  status: "passed",
}));

test("core rejects critical skips, absent tests, duplicate execution and unexpected outcomes", () => {
  assert.deepEqual(coreCoverageIssues(passing), []);
  for (const status of ["skipped", "failed", "timedOut", "interrupted"]) {
    assert.equal(
      coreCoverageIssues([{ ...passing[0], status }, ...passing.slice(1)])
        .length,
      1,
    );
  }
  assert.equal(coreCoverageIssues(passing.slice(1)).length, 1);
  assert.equal(coreCoverageIssues([...passing, passing[0]]).length, 1);
  assert.equal(
    coreCoverageIssues([
      { ...passing[0], outcome: "unexpected" },
      ...passing.slice(1),
    ]).length,
    1,
  );
});

test("actual core reporter converts a green job with critical skip into failure", async () => {
  const reporter = new BrowserCoreReporter();
  const listedTests = passing.map((entry) => ({
    parent: { project: () => ({ name: entry.project }) },
    location: { file: entry.file },
    title: entry.title,
    outcome: () => entry.outcome,
    results: [{ status: entry.status }],
  }));
  reporter.onBegin(undefined, { allTests: () => listedTests });
  assert.equal((await reporter.onEnd({ status: "passed" })).status, "passed");
  listedTests[0].results = [{ status: "skipped" }];
  assert.equal((await reporter.onEnd({ status: "passed" })).status, "failed");
});

test("core grep matches exact named consumer but excludes generic matrices", () => {
  for (const [project, file, title] of browserCore) {
    assert.equal(
      coreGrep(project).test(`${project} ${file} nested suite ${title}`),
      true,
    );
    assert.equal(
      coreGrep(project).test(
        `${project} ${file} nested suite ${title} new variant`,
      ),
      false,
    );
  }
  assert.equal(
    coreGrep("desktop").test(
      "desktop shell.spec.ts manifest route matrix 1280px shard 1",
    ),
    false,
  );
  for (
    const title of [
      "shell.spec.ts manifest route matrix phone fixture-auth:login-default",
      "shell.spec.ts manifest route matrix phone route manifest matches the running app",
    ]
  ) {
    assert.equal(coreGrep("desktop").test(`desktop ${title}`), false);
    assert.equal(coreGrep("mobile").test(`mobile ${title}`), false);
  }
});

test("sharded full coverage partitions fixtures per project and pins the auth chain to one shard", () => {
  const selection = { full: true, webSpecs: [], storybook: true };
  const total = 4;
  const stateful = 3;
  const sliceKeys = [];
  for (let index = 1; index <= total; index++) {
    const shard = { index, total, stateful };
    const commands = browserCommands("web", selection, shard);
    assert.ok(commands.every((c) => c.mode === "full" && c.requireCore));
    assert.ok(commands.every((c) => c.presentOnly));
    const chain = commands.filter((c) =>
      c.projects.includes("desktop-auth-bootstrap")
    );
    assert.equal(chain.length, index === stateful ? 1 : 0);
    if (chain.length) {
      assert.equal(
        commands[0],
        chain[0],
        "chain runs before the fixture slices",
      );
      assert.ok(chain[0].projects.includes("desktop-shared-admin"));
      assert.equal(chain[0].shard, undefined, "the chain is never sliced");
    }
    for (const fixture of commands.filter((c) => c.shard)) {
      assert.equal(fixture.seedAdmin, index !== stateful);
      sliceKeys.push(`${fixture.projects.join(",")}@${fixture.shard}`);
    }
  }
  assert.deepEqual(
    sliceKeys.toSorted(),
    ["desktop", "mobile"].flatMap((project) =>
      [1, 2, 3, 4].map((i) => `${project}@${i}/4`)
    ).toSorted(),
    "each fixture project is sliced into every shard exactly once",
  );
});

test("sharded narrow selection stays whole on shard 1 and is empty elsewhere", () => {
  const selection = {
    full: false,
    webSpecs: ["tasks.spec.ts"],
    storybook: false,
  };
  const unsharded = browserCommands("web", selection);
  assert.deepEqual(
    browserCommands("web", selection, { index: 1, total: 4, stateful: 3 }),
    unsharded,
  );
  for (const index of [2, 3, 4]) {
    assert.deepEqual(
      browserCommands("web", selection, { index, total: 4, stateful: 3 }),
      [],
    );
  }
});

test("shard environment parses one-based index/total and rejects bad values", () => {
  assert.equal(readBrowserShard({}), null);
  assert.deepEqual(
    readBrowserShard({
      BAKERY_BROWSER_SHARD: "2/4",
      BAKERY_BROWSER_STATEFUL_SHARD: "3",
    }),
    { index: 2, total: 4, stateful: 3 },
  );
  for (const bad of ["0/4", "5/4", "a/b", "2", "2/4/1"]) {
    assert.throws(() => readBrowserShard({ BAKERY_BROWSER_SHARD: bad }));
  }
  assert.throws(() =>
    readBrowserShard({
      BAKERY_BROWSER_SHARD: "1/4",
      BAKERY_BROWSER_STATEFUL_SHARD: "5",
    })
  );
});

test("sharded core check ignores absent cases but still fails a present one that did not pass", () => {
  const passing = browserCore.map(([project, file, title]) => ({
    project,
    file,
    title,
    outcome: "expected",
    status: "passed",
  }));
  const slice = passing.slice(0, 5);
  assert.deepEqual(coreCoverageIssues(slice, { presentOnly: true }), []);
  assert.equal(coreCoverageIssues(slice).length, browserCore.length - 5);
  assert.equal(
    coreCoverageIssues([{ ...slice[0], status: "skipped" }], {
      presentOnly: true,
    }).length,
    1,
  );
  assert.equal(
    coreCoverageIssues([slice[0], slice[0]], { presentOnly: true }).length,
    1,
  );
});

test("whole-suite listing check requires each core case exactly once", () => {
  const listed = browserCore.map(([project, file, title]) => ({
    project,
    file,
    title,
  }));
  assert.deepEqual(coreListingIssues(listed), []);
  assert.equal(coreListingIssues(listed.slice(1)).length, 1);
  assert.equal(coreListingIssues([...listed, listed[0]]).length, 1);
});
