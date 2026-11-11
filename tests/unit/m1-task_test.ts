import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  addedLines,
  addsOnlyComments,
  checkBriefApprovedPlan,
  checkDuplicateDecision,
  claudeInitModels,
  decideRefused,
  type DocTarget,
  isCommentLine,
  M1_RUN_TASKS,
  M1_TASK_DESCRIPTION,
  M1_TASK_FILE,
  M1_TASK_FUNCTION,
  patchFiles,
  removesNothing,
  type RunTaskKey,
  verifyDocCommentPatch,
} from "../../apps/web/tests/helpers/m1-task.ts";

const repositoryRoot = new URL("../../", import.meta.url);

Deno.test("the M1 task names an existing file that exports an undocumented function", async () => {
  const source = await Deno.readTextFile(new URL(M1_TASK_FILE, repositoryRoot));
  const lines = source.split("\n");
  const declaration = new RegExp(
    `^export (async )?function ${M1_TASK_FUNCTION}\\b`,
  );
  const index = lines.findIndex((line) => declaration.test(line));
  assert(index >= 0, `${M1_TASK_FILE} must export ${M1_TASK_FUNCTION}`);
  // Exactly one declaration, so the task cannot mean a different function.
  assertEquals(lines.filter((line) => declaration.test(line)).length, 1);
  let previous = index - 1;
  while (previous >= 0 && lines[previous].trim() === "") previous--;
  const above = previous >= 0 ? lines[previous].trim() : "";
  assert(
    !above.endsWith("*/") && !above.startsWith("//") && !above.startsWith("*"),
    `${M1_TASK_FUNCTION} already has a comment above it: ${above}`,
  );
  // The file is hand-written source, not generated.
  assert(!/@generated|do not edit/i.test(source.slice(0, 400)));
  assert(!M1_TASK_FILE.includes("generated"));
  assert(!/(_test|\.test|\.spec)\.tsx?$/.test(M1_TASK_FILE));
});

Deno.test("the task text names the file, the function and the one-paragraph limit", () => {
  assertStringIncludes(M1_TASK_DESCRIPTION, M1_TASK_FUNCTION);
  assertStringIncludes(M1_TASK_DESCRIPTION, M1_TASK_FILE);
  assertStringIncludes(M1_TASK_DESCRIPTION, "one accurate paragraph");
  assertStringIncludes(M1_TASK_DESCRIPTION, "Change nothing else");
});

const COMMENT_ONLY_PATCH = [
  "diff --git a/packages/ui/src/atoms/theme.ts b/packages/ui/src/atoms/theme.ts",
  "index 1111111..2222222 100644",
  "--- a/packages/ui/src/atoms/theme.ts",
  "+++ b/packages/ui/src/atoms/theme.ts",
  '@@ -5,6 +5,10 @@ const DARK_SCHEME = "(prefers-color-scheme: dark)";',
  " ",
  "+/**",
  "+ * Maps a stored value to a theme name.",
  "+ */",
  " export function parseTheme(value: unknown): Theme {",
  "",
].join("\n");

Deno.test("patchFiles lists each changed file once, in diff order", () => {
  assertEquals(patchFiles(COMMENT_ONLY_PATCH), [M1_TASK_FILE]);
  assertEquals(
    patchFiles(
      "diff --git a/one.ts b/one.ts\n+x\ndiff --git a/two.ts b/three.ts\n",
    ),
    ["one.ts", "two.ts", "three.ts"],
  );
  assertEquals(patchFiles(""), []);
});

Deno.test("a comment-only patch is accepted and anything else is not", () => {
  assertEquals(addedLines(COMMENT_ONLY_PATCH), [
    "/**",
    " * Maps a stored value to a theme name.",
    " */",
  ]);
  assert(addsOnlyComments(COMMENT_ONLY_PATCH));
  assert(removesNothing(COMMENT_ONLY_PATCH));
  const withCode = COMMENT_ONLY_PATCH + "+export const added = 1;\n";
  assert(!addsOnlyComments(withCode));
  const withRemoval = COMMENT_ONLY_PATCH + "-export const removed = 1;\n";
  assert(!removesNothing(withRemoval));
  assert(!addsOnlyComments(""), "an empty patch adds nothing");
  assert(isCommentLine("  // note"));
  assert(!isCommentLine("  return value;"));
});

Deno.test("claudeInitModels reads the model of each system/init record", () => {
  const stdout = [
    '{"type":"system","subtype":"init","model":"claude-sonnet-5-5","tools":[]}',
    "not json",
    '{"type":"assistant","model":"ignored"}',
    '{"type":"system","subtype":"status","model":"ignored"}',
    '{"type":"system","subtype":"init"}',
    '{"type":"system","subtype":"init","model":"other-model"}',
    '{"type":"system","subtype":"init","model":',
  ].join("\n");
  assertEquals(claudeInitModels(stdout), ["claude-sonnet-5-5", "other-model"]);
  assertEquals(claudeInitModels(""), []);
});

// ---- one distinct task per funded run (review F8) -------------------------------------
const RUN_KEYS: readonly RunTaskKey[] = ["main", "faults", "cancel", "queued"];

function declarationCount(source: string, fn: string): number {
  const declaration = new RegExp(
    `^export (async )?(function\\*? ${fn}\\b|const ${fn}\\b)`,
    "gm",
  );
  return source.match(declaration)?.length ?? 0;
}

async function assertUndocumented(target: DocTarget) {
  const source = await Deno.readTextFile(new URL(target.file, repositoryRoot));
  assertEquals(
    declarationCount(source, target.fn),
    1,
    `${target.file} must export ${target.fn} exactly once`,
  );
  const lines = source.split("\n");
  const index = lines.findIndex((line) =>
    new RegExp(`^export (async )?function ${target.fn}\\b`).test(line)
  );
  assert(index >= 0, `${target.fn} is a function declaration`);
  let previous = index - 1;
  while (previous >= 0 && lines[previous].trim() === "") previous--;
  const above = previous >= 0 ? lines[previous].trim() : "";
  assert(
    !above.endsWith("*/") && !above.startsWith("//") && !above.startsWith("*"),
    `${target.fn} already has a comment above it: ${above}`,
  );
  assert(!/@generated|do not edit/i.test(source.slice(0, 400)), target.file);
  assert(!target.file.includes("generated"), target.file);
  assert(!/(_test|\.test|\.spec)\.tsx?$/.test(target.file), target.file);
}

Deno.test("each funded run has its own task over undocumented, distinct functions", async () => {
  assertEquals(Object.keys(M1_RUN_TASKS).sort(), [...RUN_KEYS].sort());
  assertEquals(M1_RUN_TASKS.main.targets, [
    { file: M1_TASK_FILE, fn: M1_TASK_FUNCTION },
  ]);
  const functions = new Set<string>();
  const files = new Set<string>();
  const titles = new Set<string>();
  const descriptions = new Set<string>();
  for (const key of RUN_KEYS) {
    const task = M1_RUN_TASKS[key];
    assertEquals(task.targets.length, key === "main" ? 1 : 3, key);
    titles.add(task.title);
    descriptions.add(task.description);
    for (const target of task.targets) {
      await assertUndocumented(target);
      assert(!functions.has(target.fn), `${target.fn} is used by two runs`);
      assert(!files.has(target.file), `${target.file} is used by two runs`);
      functions.add(target.fn);
      files.add(target.file);
      if (key !== "main") {
        assert(target.fn !== M1_TASK_FUNCTION, "parseTheme belongs to main");
        assert(target.file !== M1_TASK_FILE, "theme.ts belongs to main");
      }
      assertStringIncludes(task.description, target.fn);
      assertStringIncludes(task.description, target.file);
    }
    if (key !== "main") {
      assertStringIncludes(task.description, "deno fmt --check");
      assertStringIncludes(task.description, "one-paragraph");
    }
  }
  assertEquals(functions.size, 10);
  assertEquals(files.size, 10);
  assertEquals(titles.size, 4, "four distinct titles");
  assertEquals(descriptions.size, 4, "four distinct task texts");
});

// ---- the patch check pins the function, not a hunk header (review F6) ---------------------
const THEME_ABOVE_PARSE = [
  "diff --git a/packages/ui/src/atoms/theme.ts b/packages/ui/src/atoms/theme.ts",
  "index 1111111..2222222 100644",
  "--- a/packages/ui/src/atoms/theme.ts",
  "+++ b/packages/ui/src/atoms/theme.ts",
  '@@ -5,6 +5,9 @@ const DARK_SCHEME = "(prefers-color-scheme: dark)";',
  " ",
  "+/**",
  "+ * Maps a stored value to a theme name.",
  "+ */",
  " export function parseTheme(value: unknown): Theme {",
  "   switch (value) {",
  "",
].join("\n");

const THEME_ABOVE_RESOLVE = [
  "diff --git a/packages/ui/src/atoms/theme.ts b/packages/ui/src/atoms/theme.ts",
  "--- a/packages/ui/src/atoms/theme.ts",
  "+++ b/packages/ui/src/atoms/theme.ts",
  "@@ -18,6 +18,9 @@ export function parseTheme(value: unknown): Theme {",
  "   }",
  " }",
  " ",
  "+/**",
  "+ * Resolves a theme.",
  "+ */",
  " export function resolveTheme(",
  "   theme: Theme,",
  "",
].join("\n");

const MAIN: readonly DocTarget[] = M1_RUN_TASKS.main.targets;

Deno.test("verifyDocCommentPatch accepts a comment directly above the named function", () => {
  assertEquals(verifyDocCommentPatch(THEME_ABOVE_PARSE, MAIN), []);
});

Deno.test("verifyDocCommentPatch rejects a comment above another function even when the hunk header names the target", () => {
  const problems = verifyDocCommentPatch(THEME_ABOVE_RESOLVE, MAIN);
  assert(problems.length > 0, "the hunk header must not satisfy the check");
  assert(problems.some((problem) => problem.includes("parseTheme")));
});

Deno.test("verifyDocCommentPatch rejects extra files, code, removals, a second block and no change", () => {
  const second = THEME_ABOVE_PARSE.replace(
    "   switch (value) {",
    "+// stray\n   switch (value) {",
  );
  const code = THEME_ABOVE_PARSE.replace("+ */", "+ */\n+export const x = 1;");
  const removal = THEME_ABOVE_PARSE.replace(
    "   switch (value) {",
    "-  switch (value) {",
  );
  const otherFile = THEME_ABOVE_PARSE +
    "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,2 @@\n+# x\n # y\n";
  for (
    const [label, diff] of [
      ["second block", second],
      ["code line", code],
      ["removal", removal],
      ["extra file", otherFile],
      ["empty", ""],
    ] as const
  ) {
    assert(
      verifyDocCommentPatch(diff, MAIN).length > 0,
      `${label} must be rejected`,
    );
  }
});

Deno.test("verifyDocCommentPatch checks every named function of a three-function run", () => {
  const targets = M1_RUN_TASKS.faults.targets;
  const section = (target: DocTarget) =>
    [
      `diff --git a/${target.file} b/${target.file}`,
      `--- a/${target.file}`,
      `+++ b/${target.file}`,
      "@@ -10,3 +10,6 @@",
      " }",
      " ",
      "+/**",
      `+ * Documents ${target.fn}.`,
      "+ */",
      ` export function ${target.fn}(...) {`,
      "",
    ].join("\n");
  const all = targets.map(section).join("");
  assertEquals(verifyDocCommentPatch(all, targets), []);
  const missingOne = targets.slice(0, 2).map(section).join("");
  const problems = verifyDocCommentPatch(missingOne, targets);
  assert(problems.some((problem) => problem.includes(targets[2].fn)));
});

// ---- the brief artifact carries the approved revision (review F2) ---------------------------
const EXPECTED_PLAN = {
  revision: 2,
  planRevisionId: "33333333-3333-4333-8333-333333333333",
  digest: "d".repeat(64),
};
const brief = (approvedPlan: unknown) =>
  JSON.stringify({
    schema: "bakery.task-brief/v1",
    title: "T",
    ...(approvedPlan === undefined ? {} : { approvedPlan }),
  });

Deno.test("checkBriefApprovedPlan fails only on a real mismatch", () => {
  assertEquals(
    checkBriefApprovedPlan(
      brief({ ...EXPECTED_PLAN, title: "x", steps: [] }),
      EXPECTED_PLAN,
    ),
    [],
  );
  assert(
    checkBriefApprovedPlan(
      brief({ ...EXPECTED_PLAN, revision: 1 }),
      EXPECTED_PLAN,
    )
      .some((problem) => problem.includes("revision")),
  );
  assert(
    checkBriefApprovedPlan(
      brief({ ...EXPECTED_PLAN, planRevisionId: crypto.randomUUID() }),
      EXPECTED_PLAN,
    ).some((problem) => problem.includes("planRevisionId")),
  );
  assert(
    checkBriefApprovedPlan(
      brief({ ...EXPECTED_PLAN, digest: "0" }),
      EXPECTED_PLAN,
    )
      .some((problem) => problem.includes("digest")),
  );
  assert(checkBriefApprovedPlan(brief(undefined), EXPECTED_PLAN).length > 0);
  assert(checkBriefApprovedPlan("not json", EXPECTED_PLAN).length > 0);
  assert(
    checkBriefApprovedPlan(
      JSON.stringify({ schema: "other", approvedPlan: EXPECTED_PLAN }),
      EXPECTED_PLAN,
    ).length > 0,
  );
});

// ---- the expired-approval decision reads the response of the path it used (review F3) ---
Deno.test("decideRefused reads the page response on the UI path", async () => {
  const result = await decideRefused({
    clickApprove: () => Promise.resolve(),
    uiResponse: Promise.resolve({ status: 409, body: "expired" }),
    sendByApi: () => Promise.reject(new Error("the API path must not run")),
  });
  assertEquals(result, { status: 409, body: "expired", path: "ui" });
});

Deno.test("decideRefused falls back to the API result and never waits for the page response", async () => {
  const result = await decideRefused({
    clickApprove: () => Promise.reject(new Error("button is gone")),
    // A page response that never arrives: awaiting it would hang the test.
    uiResponse: new Promise(() => {}),
    sendByApi: () =>
      Promise.resolve({ status: 409, body: "approval_unavailable" }),
  });
  assertEquals(result, {
    status: 409,
    body: "approval_unavailable",
    path: "api",
  });
});

Deno.test("decideRefused fails when a clicked decision never reached the server", async () => {
  await assertRejects(
    () =>
      decideRefused({
        clickApprove: () => Promise.resolve(),
        uiResponse: Promise.resolve(null),
        sendByApi: () => Promise.resolve({ status: 200, body: "" }),
      }),
    Error,
    "M1_DECISION_NOT_SEEN",
  );
});

// ---- a duplicate approve is acknowledged, a conflicting decision is refused (review F12) ---
const APPROVED = {
  id: "55555555-5555-4555-8555-555555555555",
  status: "answered",
  version: 3,
  decision: "approve",
};

const duplicateOutcome = (overrides: {
  identical?: { status: number; body: Record<string, unknown> };
  conflicting?: { status: number; body: Record<string, unknown> };
  after?: typeof APPROVED;
} = {}) => ({
  before: APPROVED,
  identical: { status: 200, body: { ...APPROVED } },
  conflicting: {
    status: 409,
    body: { code: "STATE_CONFLICT", reason: "approval_decided" },
  },
  after: APPROVED,
  ...overrides,
});

Deno.test("checkDuplicateDecision accepts what the server does: 200 replay, 409 for a conflicting decision", () => {
  assertEquals(checkDuplicateDecision(duplicateOutcome()), []);
});

Deno.test("checkDuplicateDecision fails on a real mismatch only", () => {
  const cases: [string, ReturnType<typeof duplicateOutcome>][] = [
    [
      "a replay that is refused",
      duplicateOutcome({ identical: { status: 409, body: {} } }),
    ],
    [
      "a replay that returns another approval",
      duplicateOutcome({
        identical: {
          status: 200,
          body: { ...APPROVED, id: crypto.randomUUID() },
        },
      }),
    ],
    [
      "a replay that bumps the version",
      duplicateOutcome({
        identical: { status: 200, body: { ...APPROVED, version: 4 } },
      }),
    ],
    [
      "a conflicting decision that is accepted",
      duplicateOutcome({ conflicting: { status: 200, body: { ...APPROVED } } }),
    ],
    [
      "a conflicting decision refused for another reason",
      duplicateOutcome({
        conflicting: { status: 409, body: { reason: "approval_stale" } },
      }),
    ],
    [
      "a stored approval that changed",
      duplicateOutcome({
        after: { ...APPROVED, version: 4, decision: "reject" },
      }),
    ],
  ];
  for (const [label, outcome] of cases) {
    assert(checkDuplicateDecision(outcome).length > 0, `${label} must fail`);
  }
});
