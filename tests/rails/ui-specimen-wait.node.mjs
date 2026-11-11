// Storybook mounts `.storybook-story` after `load`, so every navigation races
// the first render. The canonical loops walk all 77 stories in sequence while
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

const occurrences = (source, needle) => {
  const found = [];
  for (let at = source.indexOf(needle); at !== -1;) {
    found.push(at);
    at = source.indexOf(needle, at + needle.length);
  }
  return found;
};
const lineOf = (source, index) => source.slice(0, index).split("\n").length;

test("packages/ui/tests holds exactly one specimen wait, in the harness", () => {
  const sites = occurrences(harness, SPECIMEN);
  assert.equal(
    sites.length,
    1,
    `storybook-harness.ts locates the specimen ${sites.length} times; the ` +
      "harness must hold exactly one, inside waitForSpecimen()",
  );
  const helper = /export async function waitForSpecimen\([\s\S]*?\n}/.exec(
    harness,
  );
  assert.ok(helper, "storybook-harness.ts must export waitForSpecimen()");
  assert.ok(
    sites[0] > helper.index && sites[0] < helper.index + helper[0].length,
    "the specimen locator must live inside waitForSpecimen()",
  );
  assert.match(
    helper[0],
    /waitFor\(\{[^}]*state: "visible"[^}]*timeout: specimenTimeout[^}]*\}\)/,
    "waitForSpecimen() must wait for visibility on the specimenTimeout budget",
  );
  assert.equal(
    occurrences(helper[0], "timeout: specimenTimeout").length,
    2,
    "both the first wait and the wait after recovery must take the shared " +
      "budget",
  );
  assert.equal(
    occurrences(helper[0], ".reload(").length,
    1,
    "recovery must reload exactly once; a loop would turn a broken story " +
      "into a hang instead of a failure",
  );
});

test("the shared wait outlasts the expect default it replaced", () => {
  const declared = /export const specimenTimeout = ([\d_]+);/.exec(harness);
  assert.ok(declared, "storybook-harness.ts must export specimenTimeout");
  const budget = Number(declared[1].replaceAll("_", ""));
  const configured = /expect:\s*\{[^}]*timeout:\s*([\d_]+)/.exec(config);
  const expectBudget = configured
    ? Number(configured[1].replaceAll("_", ""))
    : EXPECT_DEFAULT;
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
  const violations = specs.flatMap((name) => {
    const source = read(name);
    return occurrences(source, SPECIMEN)
      .filter((at) => !source.startsWith(".evaluate(", at + SPECIMEN.length))
      .map((at) => `${name}:${lineOf(source, at)}`);
  });
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
    if (!source.includes("waitForSpecimen(")) return false;
    return !/import \{[\s\S]*?waitForSpecimen,[\s\S]*?\} from\s+"\.\/storybook-harness\.ts"/
      .test(source);
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
    Object.keys(expected).map((name) => [
      name,
      occurrences(read(name), "waitForSpecimen(").length +
      occurrences(read(name), "openStory(").length,
    ]),
  );
  assert.deepEqual(
    observed,
    expected,
    "a canonical-story loop lost its shared specimen wait",
  );
});

test("openStory waits through the shared specimen wait", () => {
  const body = /export async function openStory\([\s\S]*?\n}\n/.exec(harness)
    ?.[0] ?? "";
  assert.match(
    body,
    /await waitForSpecimen\(page\)/,
    "openStory must wait for the specimen with waitForSpecimen(page)",
  );
});
