import { assertEquals } from "@std/assert";

// #559: a whole-test budget in apps/web/tests goes through laneBudgetMs, so it is
// scaled for the slow CI hosts in one place. A bare number is right for one
// host and short for another (learnings/heavy-lane-label-is-pool-not-cpu.xml).

const DIRECTORIES = [
  new URL("../../apps/web/tests/", import.meta.url),
  new URL("../../tests/browser/", import.meta.url),
];
const TESTS = DIRECTORIES[0];

/**
 * Specs whose budgets are the product's own deadlines, not a guess about host
 * speed: they drive a real model and worker, each phase's budget is what the
 * model and worker need when they behave, and the owner opts in to run them.
 */
export const PRODUCT_DEADLINE_SPECS = [
  "m1-journey-real.spec.ts",
  "run-observation-real-harness.spec.ts",
];

/** Lines whose whole-test budget is a bare number or a constant of numbers. */
export function unscaledBudgets(source: string): number[] {
  const lines: number[] = [];
  source.split("\n").forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, "");
    const call = /(?:test\.setTimeout|test\.describe\.configure)\((.*)/.exec(
      code,
    );
    if (!call) return;
    if (
      /laneBudgetMs\(|sweepTimeoutMs\(|MATRIX_CASE_TIMEOUT_MS|\bBUDGET\./.test(
        call[1],
      )
    ) return;
    if (/[0-9]/.test(call[1]) || /MINUTE/.test(call[1])) lines.push(index + 1);
  });
  return lines;
}

Deno.test("no browser spec holds a bare whole-test budget", () => {
  const found: string[] = [];
  for (const directory of DIRECTORIES) {
    for (const entry of Deno.readDirSync(directory)) {
      if (!entry.isFile || !entry.name.endsWith(".spec.ts")) continue;
      if (PRODUCT_DEADLINE_SPECS.includes(entry.name)) continue;
      const source = Deno.readTextFileSync(new URL(entry.name, directory));
      for (const line of unscaledBudgets(source)) {
        found.push(`${entry.name}:${line}`);
      }
    }
  }
  assertEquals(
    found,
    [],
    "use test.setTimeout(laneBudgetMs(<fast-host ms>)) from lane-budget.ts",
  );
});

Deno.test("a matrix budget constant is scaled where it is defined", () => {
  for (const name of ["shell.spec.ts", "settings-states.spec.ts"]) {
    const source = Deno.readTextFileSync(new URL(name, TESTS));
    assertEquals(
      /const MATRIX_CASE_TIMEOUT_MS = laneBudgetMs\([0-9_]+\);/.test(source),
      true,
      `${name} defines MATRIX_CASE_TIMEOUT_MS as a bare number`,
    );
  }
});

Deno.test("the rail sees a bare budget, a scaled one and a constant", () => {
  assertEquals(unscaledBudgets("test.setTimeout(90_000);"), [1]);
  assertEquals(unscaledBudgets("test.setTimeout(3 * MINUTE);"), [1]);
  assertEquals(
    unscaledBudgets("test.describe.configure({ timeout: 240_000 });"),
    [1],
  );
  assertEquals(unscaledBudgets("test.setTimeout(laneBudgetMs(90_000));"), []);
  assertEquals(unscaledBudgets("test.setTimeout(MATRIX_CASE_TIMEOUT_MS);"), []);
  assertEquals(unscaledBudgets("// test.setTimeout(90_000);"), []);
  assertEquals(unscaledBudgets("ok();\ntest.setTimeout(45_000);"), [2]);
});
