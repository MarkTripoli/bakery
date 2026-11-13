// Storybook mounts `.storybook-story` after `load`, so every navigation races
// the first render. The canonical loops walk every canonical story in sequence while
// the other worker does the same, and `packages/ui/playwright.config.ts` sets
// no retries, so one specimen that paints late fails `ui / storybook browser`
// — the lane all three `ui / paper parity` lanes gate on. This rail keeps the
// whole suite on the harness's single shared wait so the 5 s `expect` default
// cannot creep back onto that element.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TESTS = fileURLToPath(
  new URL("../../packages/ui/tests/", import.meta.url),
);
const read = (path) => readFileSync(new URL(path, `file://${TESTS}`), "utf8");

const SPECIMEN = 'locator(".storybook-story")';
const EXPECT_DEFAULT = 5_000;

const harness = read("storybook-harness.ts");
const config = read("../playwright.config.ts");
const specs = readdirSync(TESTS).filter((name) => name.endsWith(".spec.ts"));

// Every check below matches source text, so a comment or a string literal that
// holds the pinned call would satisfy a pin while the real call lost its
// argument (#190). `codeMask` marks which characters are code; a match counts
// only when it starts in code. Strings, template text, comments and regular
// expression literals are not code; the expressions inside `${}` are.
//
// It is a small scanner, not a parser: it decides whether a `/` opens a regular
// expression from the last significant character before it. That is right for
// everything the rail reads today and has known limits it does not try to
// resolve: a regex after `)` (`if (x) /re/.test(y)`) or after `else`, a `/`
// after the `}` that closes an object (`{}\n/ 2`), `Array<T> / 2`, JSX text
// with an apostrophe (the rail reads `.ts`), and a `//` comment ended only by
// U+2028 or a lone CR are read the other way. Where it cannot tell it reads a
// `/` as division, so what follows stays code.
const REGEX_PRECEDERS = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|void|throw|in|of)$/;

export function codeMask(source) {
  const mask = new Uint8Array(source.length);
  const templates = []; // brace depth inside each open `${ }`
  let previous = ""; // last significant code character
  let beforePrevious = ""; // the one before it, to tell `n++ / 2` from `+ /re/`
  const significant = (character) => {
    beforePrevious = previous;
    previous = character;
  };
  let i = 0;
  const skipString = (quote) => {
    i += 1;
    while (i < source.length && source[i] !== quote && source[i] !== "\n") {
      i += source[i] === "\\" ? 2 : 1;
    }
    i += 1;
  };
  const skipTemplate = () => {
    // Called with `i` just after an opening backtick or a closing `}` of `${}`.
    while (i < source.length) {
      if (source[i] === "\\") i += 2;
      else if (source[i] === "`") {
        i += 1;
        return;
      } else if (source[i] === "$" && source[i + 1] === "{") {
        i += 2;
        templates.push(0);
        return;
      } else i += 1;
    }
  };
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (char === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (char === "'" || char === '"') {
      skipString(char);
      significant("s");
    } else if (char === "`") {
      i += 1;
      skipTemplate();
      significant("s");
    } else if (
      char === "/" &&
      (previous === "" ||
        // `n++ / 2` and `n-- / 2` divide: a `+` or `-` that repeats is a
        // postfix operator, not the start of an operand.
        (REGEX_PRECEDERS.has(previous) &&
          !((previous === "+" || previous === "-") &&
            beforePrevious === previous)) ||
        // `return /re/`: the keyword ends just before the spaces.
        REGEX_KEYWORDS.test(
          source.slice(Math.max(0, i - 200), i).trimEnd().slice(-8),
        ))
    ) {
      i += 1;
      let inClass = false;
      while (i < source.length && source[i] !== "\n") {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) break;
        i += 1;
      }
      i += 1;
      significant("s");
    } else {
      if (templates.length > 0) {
        if (char === "{") templates[templates.length - 1] += 1;
        else if (char === "}") {
          if (templates[templates.length - 1] === 0) {
            templates.pop();
            i += 1;
            skipTemplate();
            significant("s");
            continue;
          }
          templates[templates.length - 1] -= 1;
        }
      }
      mask[i] = 1;
      if (!/\s/.test(char)) significant(char);
      i += 1;
    }
  }
  return mask;
}

/** Offsets of `needle` that start in code. */
export const occurrences = (source, needle) => {
  const mask = codeMask(source);
  const found = [];
  for (let at = source.indexOf(needle); at !== -1;) {
    if (mask[at] === 1) found.push(at);
    at = source.indexOf(needle, at + needle.length);
  }
  return found;
};

/** The first match of `pattern` that starts in code, like `RegExp.exec`. */
export const execInCode = (source, pattern) => {
  const mask = codeMask(source);
  const global = new RegExp(
    pattern.source,
    pattern.flags.replace("g", "") + "g",
  );
  for (let match = global.exec(source); match; match = global.exec(source)) {
    if (mask[match.index] === 1) return match;
    if (match[0].length === 0) global.lastIndex += 1;
  }
  return null;
};

const lineOf = (source, index) => source.slice(0, index).split("\n").length;

// The sweep-budget checks as functions of the spec text, so the decoy cases
// below can feed them text the real spec never holds.
const SCENARIO_BUDGET =
  /test\.setTimeout\(sweepTimeoutMs\(scenarios\.length\)\)/;
export const budgetsEveryScenario = (spec) =>
  execInCode(spec, SCENARIO_BUDGET) !== null;
const digits = (match) => (match ? Number(match[1].replaceAll("_", "")) : null);
/** The harness's `specimenTimeout`, or null. */
export const specimenTimeoutOf = (harness) =>
  digits(execInCode(harness, /export const specimenTimeout = ([\d_]+);/));
/** The Playwright `expect` timeout the config sets, or null when it keeps the default. */
export const expectTimeoutOf = (config) =>
  digits(execInCode(config, /expect:\s*\{[^}]*timeout:\s*([\d_]+)/));
/** The per-story sweep allowance the harness exports, or null. */
export const sweepAllowanceOf = (harness) =>
  digits(execInCode(harness, /export const SWEEP_MS_PER_STORY = ([\d_]+);/));
export const multipliesCatalog = (harness) =>
  execInCode(
    harness,
    /catalog\.entries\.length \* passes \* SWEEP_MS_PER_STORY/,
  ) !== null;
export const loopsScenarios = (spec) =>
  execInCode(spec, /for \(const scenario of scenarios\)/) !== null;
export const openStoryWaits = (harness) => {
  const body = execInCode(
    harness,
    /export async function openStory\([\s\S]*?\n}\n/,
  )?.[0] ?? "";
  return execInCode(body, /await waitForSpecimen\(page\)/) !== null;
};
/** Lines of a spec that locate the specimen for something other than evaluate(). */
export const waitViolations = (source) =>
  occurrences(source, SPECIMEN)
    .filter((at) => !source.startsWith(".evaluate(", at + SPECIMEN.length))
    .map((at) => lineOf(source, at));
/** Offsets in the harness that locate the specimen. */
export const specimenSites = (harness) => occurrences(harness, SPECIMEN);
/** The match of `waitForSpecimen()`'s source in the harness, or null. */
export const waitHelperOf = (harness) =>
  execInCode(harness, /export async function waitForSpecimen\([\s\S]*?\n}/);
/** Whether the helper waits for visibility on the shared budget. */
export const waitsForVisibility = (helper) =>
  execInCode(
    helper,
    /waitFor\(\{[^}]*state: "visible"[^}]*timeout: specimenTimeout[^}]*\}\)/,
  ) !== null;
export const sharedBudgetUses = (helper) =>
  occurrences(helper, "timeout: specimenTimeout").length;
export const reloadCalls = (helper) => occurrences(helper, ".reload(").length;
/** Whether a spec imports `waitForSpecimen` from the harness. */
export const importsSharedWait = (source) =>
  execInCode(
    source,
    /import \{[\s\S]*?waitForSpecimen,[\s\S]*?\} from\s+"\.\/storybook-harness\.ts"/,
  ) !== null;
/** Calls to the shared wait in a spec, counting `openStory`, which waits through it. */
export const sharedWaitCalls = (source) =>
  occurrences(source, "waitForSpecimen(").length +
  occurrences(source, "openStory(").length;
export const fixedSweepBudgets = (spec) => {
  const call = "test.setTimeout(";
  return occurrences(spec, call)
    .filter((at) => !spec.startsWith("sweepTimeoutMs(", at + call.length))
    .map((at) => lineOf(spec, at));
};

test("packages/ui/tests holds exactly one specimen wait, in the harness", () => {
  const sites = specimenSites(harness);
  assert.equal(
    sites.length,
    1,
    `storybook-harness.ts locates the specimen ${sites.length} times; the ` +
      "harness must hold exactly one, inside waitForSpecimen()",
  );
  const helper = waitHelperOf(harness);
  assert.ok(helper, "storybook-harness.ts must export waitForSpecimen()");
  assert.ok(
    sites[0] > helper.index && sites[0] < helper.index + helper[0].length,
    "the specimen locator must live inside waitForSpecimen()",
  );
  assert.ok(
    waitsForVisibility(helper[0]),
    "waitForSpecimen() must wait for visibility on the specimenTimeout budget",
  );
  assert.equal(
    sharedBudgetUses(helper[0]),
    2,
    "both the first wait and the wait after recovery must take the shared " +
      "budget",
  );
  assert.equal(
    reloadCalls(helper[0]),
    1,
    "recovery must reload exactly once; a loop would turn a broken story " +
      "into a hang instead of a failure",
  );
});

test("the shared wait outlasts the expect default it replaced", () => {
  const budget = specimenTimeoutOf(harness);
  assert.ok(
    budget !== null,
    "storybook-harness.ts must export specimenTimeout",
  );
  const expectBudget = expectTimeoutOf(config) ?? EXPECT_DEFAULT;
  assert.ok(
    budget > expectBudget,
    `specimenTimeout ${budget}ms must exceed the expect budget ` +
      `${expectBudget}ms it exists to replace`,
  );
  assert.ok(
    budget >= 30_000,
    `specimenTimeout ${budget}ms must keep at least the 30 s locator budget ` +
      "the harness used before it was named",
  );
});

test("no spec waits on the specimen outside the harness", () => {
  const violations = specs.flatMap((name) =>
    waitViolations(read(name)).map((line) => `${name}:${line}`)
  );
  assert.deepEqual(
    violations,
    [],
    "these specs locate the specimen for something other than evaluate(); " +
      "call waitForSpecimen(page) from the harness instead",
  );
});

test("every spec that waits takes the wait from the harness", () => {
  const missing = specs.filter((name) => {
    const source = read(name);
    if (occurrences(source, "waitForSpecimen(").length === 0) return false;
    return !importsSharedWait(source);
  });
  assert.deepEqual(
    missing,
    [],
    "these specs call waitForSpecimen() without importing it from " +
      "./storybook-harness.ts",
  );
});

test("the catalog loops that exposed the race all use it", () => {
  const expected = {
    "storybook.spec.ts": 4,
    "storybook-context.spec.ts": 3,
    "storybook-controls.spec.ts": 1,
    "storybook-product.spec.ts": 1,
    "storybook-navigation.spec.ts": 2,
  };
  // openStory (storybook-harness.ts) opens a story through waitForSpecimen
  // and only adds a named failure report, so it counts as the shared wait.
  const observed = Object.fromEntries(
    Object.keys(expected).map((name) => [name, sharedWaitCalls(read(name))]),
  );
  assert.deepEqual(
    observed,
    expected,
    "a canonical-story loop lost its shared specimen wait",
  );
});

test("a canonical-story sweep budget scales with the catalog", () => {
  // The sweeps visit every canonical story inside one test. A fixed 360 s
  // budget passed on the fast CI hosts and timed out on a slow one under load,
  // so the budget is the catalog size times an allowance, never a constant.
  const spec = read("storybook.spec.ts");
  const fixed = fixedSweepBudgets(spec).map((line) =>
    `storybook.spec.ts:${line}`
  );
  assert.deepEqual(
    fixed,
    [],
    "these sweeps fix their budget; use test.setTimeout(sweepTimeoutMs(...)) " +
      "so it grows with the catalog",
  );
  assert.ok(
    multipliesCatalog(harness),
    "sweepTimeoutMs must multiply the catalog size by the per-story allowance",
  );
  // A sweep that repeats the catalog once per scenario must budget one pass per
  // scenario. Without the argument the budget silently halves and every other
  // check here stays green, because they only look at the call, not its count.
  assert.ok(
    loopsScenarios(spec),
    "the multi-scenario sweep this check guards is gone; update the check",
  );
  assert.ok(
    budgetsEveryScenario(spec),
    "a sweep over scenarios must budget scenarios.length passes",
  );
  const perStory = sweepAllowanceOf(harness);
  assert.ok(
    perStory !== null,
    "storybook-harness.ts must export SWEEP_MS_PER_STORY",
  );
  assert.ok(
    perStory >= 10_000,
    `SWEEP_MS_PER_STORY ${perStory}ms is below the 10 s that keeps a slow ` +
      "runner under load inside the budget (the fixed 360 s it replaced was " +
      "about 4.7 s per story)",
  );
});

test("openStory waits through the shared specimen wait", () => {
  assert.ok(
    openStoryWaits(harness),
    "openStory must wait for the specimen with waitForSpecimen(page)",
  );
});

// --- the matching itself (#190): a pin satisfied by text that is not code

const REAL_BUDGET = "test.setTimeout(sweepTimeoutMs(scenarios.length));";
const LOST_BUDGET = "test.setTimeout(sweepTimeoutMs());";

test("a comment, string or regular expression that holds the pinned call does not satisfy the pin", () => {
  assert.equal(budgetsEveryScenario(REAL_BUDGET), true);
  assert.equal(
    budgetsEveryScenario(`// ${REAL_BUDGET}\n${REAL_BUDGET}`),
    true,
    "a comment beside the real call changes nothing",
  );
  const decoys = {
    "a trailing line comment": `${LOST_BUDGET} // ${REAL_BUDGET}`,
    "a line comment above": `// ${REAL_BUDGET}\n${LOST_BUDGET}`,
    "a block comment": `${LOST_BUDGET} /* ${REAL_BUDGET} */`,
    "a multi-line block comment": `/*\n${REAL_BUDGET}\n*/\n${LOST_BUDGET}`,
    "a double-quoted string": `const note = "${REAL_BUDGET}";\n${LOST_BUDGET}`,
    "a single-quoted string": `const note = '${REAL_BUDGET}';\n${LOST_BUDGET}`,
    "template text": `const note = \`${REAL_BUDGET}\`;\n${LOST_BUDGET}`,
    "a regular expression literal":
      `const note = /${REAL_BUDGET}/;\n${LOST_BUDGET}`,
  };
  for (const [name, spec] of Object.entries(decoys)) {
    assert.equal(budgetsEveryScenario(spec), false, name);
  }
});

test("a fixed sweep budget that only appears in a comment or a string is not one", () => {
  assert.deepEqual(fixedSweepBudgets("test.setTimeout(360_000);"), [1]);
  assert.deepEqual(
    fixedSweepBudgets("ok();\ntest.setTimeout(360_000);\nmore();"),
    [2],
  );
  for (
    const text of [
      "// test.setTimeout(360_000)\ntest.setTimeout(sweepTimeoutMs(1));",
      "/* test.setTimeout(360_000) */ test.setTimeout(sweepTimeoutMs(1));",
      'const note = "test.setTimeout(360_000)";',
      "const note = `test.setTimeout(360_000)`;",
    ]
  ) {
    assert.deepEqual(fixedSweepBudgets(text), [], text);
  }
});

test("the code mask reads comments, strings, templates and regular expressions as a reader would", () => {
  const count = (source, needle) => occurrences(source, needle).length;
  // Comment markers inside a string do not start a comment.
  assert.equal(count('const a = "// not a comment"; foo();', "foo("), 1);
  assert.equal(count("const a = '/* nor this */'; foo();", "foo("), 1);
  // An escaped quote does not end the string.
  assert.equal(count('const a = "say \\" foo() \\" now"; bar();', "foo("), 0);
  assert.equal(count("const a = 'it\\'s foo()'; bar();", "foo("), 0);
  // The expression inside a template is code; its text is not.
  assert.equal(count("const a = `text foo() ${foo()} more foo()`;", "foo("), 1);
  assert.equal(count("const a = `${ { k: foo() }.k } foo()`;", "foo("), 1);
  assert.equal(count("const a = `a ${`b ${foo()} c foo()`} d`;", "foo("), 1);
  // A regular expression with a quote in it does not open a string.
  assert.equal(count('const r = /"/; foo(); const s = "foo()";', "foo("), 1);
  assert.equal(count("const r = /[/]foo()/; bar();", "foo("), 0);
  // Division is not a regular expression.
  assert.equal(count('const x = a / b; const s = "foo()"; foo();', "foo("), 1);
  // A line comment ends at the line, a block comment at its closer.
  assert.equal(count("// foo()\nfoo();", "foo("), 1);
  assert.equal(count("/* foo() */ foo(); /* foo() */", "foo("), 1);
  // A needle that contains a string still counts when it starts in code.
  assert.equal(
    count('page.locator(".storybook-story")', 'locator(".storybook-story")'),
    1,
  );
});

// --- the scanner's remaining edge cases (QA of #318): each was a wrong mask

test("the code mask keeps code after a block comment, reads an escaped slash in a regex, and tells division from a regex", () => {
  const count = (source, needle) => occurrences(source, needle).length;
  // Code after a block comment on the same line is code.
  assert.equal(count("/* a */ foo();", "foo("), 1);
  // An escaped slash does not end a regular expression.
  assert.equal(count("const r = /a\\/foo(/; bar();", "foo("), 0);
  assert.equal(count("const r = /a\\/foo(/; bar();", "bar("), 1);
  // After the `}` that ends an object inside `${}` the expression goes on.
  assert.equal(count("`${ { k: 1 }.k + foo() }`", "foo("), 1);
  // An escaped backtick does not end a template.
  assert.equal(count("const t = `a \\` foo() b`; bar();", "foo("), 0);
  assert.equal(count("const t = `a \\` foo() b`; bar();", "bar("), 1);
  // A slash right after a string is division, so the next string stays text.
  assert.equal(
    count('const x = "a" / 2; foo(); const s = "foo()";', "foo("),
    1,
  );
  // A `;` or `,` inside a line comment does not end it early.
  assert.equal(count("// note; foo()\nbar();", "foo("), 0);
  assert.equal(count("// a, b, foo()\nbar();", "foo("), 0);
  assert.equal(count("// note; foo()\nbar();", "bar("), 1);
});

test("a regex after return, typeof, case, throw, void, in or of is a regex, and n++ / 2 divides", () => {
  const count = (source, needle) => occurrences(source, needle).length;
  for (
    const keyword of ["return", "typeof", "case", "throw", "void", "in", "of"]
  ) {
    // The regex body is text, and the code after it is code.
    assert.equal(
      count(`x = ${keyword} /foo(/.test(y); bar();`, "foo("),
      0,
      `${keyword} /re/`,
    );
    assert.equal(
      count(`x = ${keyword} /foo(/.test(y); bar();`, "bar("),
      1,
      `${keyword} /re/ then code`,
    );
  }
  // The pin cannot be satisfied by a regex literal after a keyword and a space.
  assert.equal(
    budgetsEveryScenario(
      `${LOST_BUDGET}\nconst decoy = () => { return /${REAL_BUDGET}/; }`,
    ),
    false,
  );
  // A postfix operator before a slash is division, so what follows stays code.
  assert.deepEqual(
    fixedSweepBudgets("let n = 1; n++ / 2; test.setTimeout(360_000);"),
    [1],
  );
  assert.deepEqual(
    fixedSweepBudgets("let n = 1; n-- / 2; test.setTimeout(360_000);"),
    [1],
  );
  // A prefix `+` before a regex is still a regex.
  assert.equal(count("x = a + /foo(/.test(y); bar();", "foo("), 0);
});

// --- the other call sites, each fed one decoy: the old text in a comment or a
// string beside a changed value must not stand in for the value

test("a comment or string that holds the old harness or config value does not stand in for the real one", () => {
  assert.equal(
    specimenTimeoutOf(
      "// export const specimenTimeout = 60_000;\nexport const specimenTimeout = 1_000;",
    ),
    1000,
  );
  assert.equal(
    specimenTimeoutOf('const old = "export const specimenTimeout = 60_000;";'),
    null,
  );
  assert.equal(
    expectTimeoutOf(
      "// expect: { timeout: 60_000 },\nexpect: { timeout: 5_000 },",
    ),
    5000,
  );
  assert.equal(
    expectTimeoutOf("/* expect: { timeout: 60_000 } */ export default {};"),
    null,
  );
  assert.equal(
    sweepAllowanceOf(
      "// export const SWEEP_MS_PER_STORY = 20_000;\nexport const SWEEP_MS_PER_STORY = 1_000;",
    ),
    1000,
  );
  assert.equal(
    sweepAllowanceOf("// export const SWEEP_MS_PER_STORY = 20_000;"),
    null,
  );
  assert.equal(
    multipliesCatalog(
      "// catalog.entries.length * passes * SWEEP_MS_PER_STORY\nreturn 360_000;",
    ),
    false,
  );
  assert.equal(
    multipliesCatalog(
      "return catalog.entries.length * passes * SWEEP_MS_PER_STORY;",
    ),
    true,
  );
  assert.equal(
    loopsScenarios(
      '// for (const scenario of scenarios) {}\nconst note = "for (const scenario of scenarios)";',
    ),
    false,
  );
  assert.equal(loopsScenarios("for (const scenario of scenarios) {}"), true);
});

test("a comment or string that holds the specimen wait or the openStory call does not stand in for the real one", () => {
  const withoutWait =
    'export async function openStory(page) {\n  // await waitForSpecimen(page)\n  const note = "await waitForSpecimen(page)";\n}\n';
  assert.equal(openStoryWaits(withoutWait), false);
  assert.equal(
    openStoryWaits(
      "export async function openStory(page) {\n  await waitForSpecimen(page);\n}\n",
    ),
    true,
  );
  // A specimen locator in a comment or a string is not a wait outside the harness.
  assert.deepEqual(
    waitViolations('// page.locator(".storybook-story").waitFor()'),
    [],
  );
  assert.deepEqual(
    waitViolations("const s = 'page.locator(\".storybook-story\").waitFor()';"),
    [],
  );
  assert.deepEqual(
    waitViolations('await page.locator(".storybook-story").waitFor();'),
    [1],
  );
  assert.deepEqual(
    waitViolations('await page.locator(".storybook-story").evaluate(() => 1);'),
    [],
  );
});

// --- the first test, the import check and the catalog loops, each fed a decoy
// (QA of #318, low): the old text in a comment or a string must not stand in

test("a comment or string does not stand in for the harness's specimen wait, its budget or its one reload", () => {
  const locator = 'page.locator(".storybook-story")';
  assert.equal(
    specimenSites(`// ${locator}\nconst s = '${locator}';`).length,
    0,
  );
  assert.equal(specimenSites(`const l = ${locator};`).length, 1);
  assert.equal(
    // The header is commented out; the closing brace on its own line is code.
    waitHelperOf("// export async function waitForSpecimen(page) {\n}\n"),
    null,
  );
  assert.ok(waitHelperOf("export async function waitForSpecimen(page) {\n}\n"));
  const visible =
    'await x.waitFor({ state: "visible", timeout: specimenTimeout });';
  assert.equal(waitsForVisibility(`// ${visible}`), false);
  assert.equal(waitsForVisibility(`const note = '${visible}';`), false);
  assert.equal(waitsForVisibility(visible), true);
  assert.equal(
    sharedBudgetUses(
      "// timeout: specimenTimeout\n// timeout: specimenTimeout",
    ),
    0,
  );
  assert.equal(sharedBudgetUses("const s = 'timeout: specimenTimeout';"), 0);
  assert.equal(
    sharedBudgetUses(
      "{ timeout: specimenTimeout } { timeout: specimenTimeout }",
    ),
    2,
  );
  assert.equal(
    reloadCalls("// await page.reload();\nconst s = 'x.reload(';"),
    0,
  );
  assert.equal(reloadCalls("await page.reload();"), 1);
  // A loop around the reload is two reload sites once written twice, and a
  // comment is not one.
  assert.equal(reloadCalls("await page.reload(); // page.reload()"), 1);
});

test("a comment or string does not stand in for a spec's import of the shared wait or its calls", () => {
  const imp = 'import { waitForSpecimen, } from "./storybook-harness.ts";';
  assert.equal(importsSharedWait(imp), true);
  assert.equal(importsSharedWait(`// ${imp}`), false);
  assert.equal(importsSharedWait(`const note = '${imp}';`), false);
  assert.equal(importsSharedWait(`/* ${imp} */`), false);
  assert.equal(
    sharedWaitCalls("await waitForSpecimen(page); await openStory(page, id);"),
    2,
  );
  assert.equal(
    sharedWaitCalls("// await waitForSpecimen(page);\n// openStory(page, id)"),
    0,
  );
  assert.equal(
    sharedWaitCalls(
      "const a = 'waitForSpecimen(page)'; const b = `openStory(x) ${openStory(page, id)}`;",
    ),
    1,
    "template text is not a call, but the call inside ${} is",
  );
});
