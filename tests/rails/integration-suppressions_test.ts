import { assertEquals } from "@std/assert";
import {
  findSuppressionViolations,
  suppressedRules,
  unsuppressableRule,
} from "../../scripts/ci/check-suppressions.ts";

const path = "apps/server/src/modules/integrations/actions.ts";

/**
 * The fixtures are assembled from parts on purpose. The guard this file tests is
 * line-based and cannot tell a fixture from a real suppression, so a literal
 * `// deno-lint-ignore <boundary rule>` written here would fail the very gate it
 * is testing.
 */
const slashes = "//";
const lintIgnore = "deno-lint-ignore";
const lintIgnoreFile = "deno-lint-ignore-file";
const directive = (rules: string) => `${slashes} ${lintIgnore} ${rules}`;
const fileDirective = (rules: string) =>
  `${slashes} ${lintIgnoreFile} ${rules}`;
const tsIgnore = `${slashes} @ts${["", "ignore"].join("-")}`;
const tsNoCheck = `${slashes} @ts${["", "nocheck"].join("-")}`;
const tsExpectError = `${slashes} @ts${["", "expect", "error"].join("-")}`;

Deno.test("a boundary rule may never be suppressed (rail B4)", () => {
  // Chapter 09 section 12.8 B4. These rules are the architecture, so a
  // suppression would re-introduce the coupling in a way no baseline can see.
  for (
    const rule of [
      "no-client-server-import",
      "bakery-boundaries/no-client-server-import",
      "bakery-boundaries/no-provider-internal-import",
      "bakery-boundaries/no-cross-provider-import",
      "bakery-boundaries/some-future-rule",
    ]
  ) {
    const violations = findSuppressionViolations(
      path,
      `${directive(rule)}\nconst x = 1;`,
    );
    assertEquals(violations.length, 1, rule);
    assertEquals(violations[0]!.line, 1);
    assertEquals(
      violations[0]!.reason.includes("may never be suppressed"),
      true,
      rule,
    );
  }
});

Deno.test("the file-wide form is banned too", () => {
  // `deno-lint-ignore-file` would silence the rule for every line in the file,
  // which is strictly worse than a single-line suppression.
  const violations = findSuppressionViolations(
    path,
    fileDirective("bakery-boundaries/no-provider-internal-import"),
  );
  assertEquals(violations.map((violation) => violation.reason), [
    "bakery-boundaries/no-provider-internal-import guards an integration boundary and may never be suppressed (rail B4)",
  ]);
});

Deno.test("a boundary rule named second in a list is still caught", () => {
  const violations = findSuppressionViolations(
    path,
    directive("no-explicit-any, no-client-server-import"),
  );
  assertEquals(violations.length, 1);
  assertEquals(violations[0]!.reason.includes("no-client-server-import"), true);
});

Deno.test("an unrelated suppression is still allowed", () => {
  // The ban is narrow on purpose: a developer may still suppress a rule that is
  // not an architectural boundary, and widening this would push people to
  // `--no-verify` instead.
  assertEquals(
    findSuppressionViolations(
      path,
      `${directive("no-explicit-any")}\nconst x: any = 1;`,
    ),
    [],
  );
});

Deno.test("the pre-existing bans are unchanged", () => {
  // Rail B4 adds one rule; it must not have disturbed what the guard already did.
  const cases: Array<[string, string]> = [
    [`${tsIgnore}\nconst x = 1;`, "banned"],
    [tsNoCheck, "banned"],
    [tsExpectError, "needs an inline reason"],
    [`${slashes} ${lintIgnore}`, "must name the rule(s)"],
  ];
  for (const [source, expectation] of cases) {
    const violations = findSuppressionViolations(path, source);
    assertEquals(violations.length, 1, source);
    assertEquals(violations[0]!.reason.includes(expectation), true, source);
  }
  // With a reason, @ts-expect-error is the sanctioned form.
  assertEquals(
    findSuppressionViolations(
      path,
      `${tsExpectError} - the SDK types land in the next slice`,
    ),
    [],
  );
});

Deno.test("suppressedRules reads the names a line suppresses", () => {
  assertEquals(
    suppressedRules(directive("a-rule another-rule")),
    ["a-rule", "another-rule"],
  );
  assertEquals(
    suppressedRules(fileDirective("a-rule")),
    ["a-rule"],
  );
  assertEquals(suppressedRules(`${slashes} ${lintIgnore}`), []);
  assertEquals(suppressedRules("// an ordinary comment"), []);
});

Deno.test("no source file in the tree suppresses a boundary rule", async () => {
  // The guard is wired into `pnpm lint`, which runs over fixed roots; this checks
  // the whole tree, including files a future lint root change could drop.
  const root = new URL("../..", import.meta.url).pathname;
  const offenders: string[] = [];
  for (
    const directory of [
      "apps",
      "packages",
      "scripts",
      "tests",
    ]
  ) {
    for await (const file of codeFiles(`${root}${directory}/`)) {
      const text = await Deno.readTextFile(file);
      if (
        unsuppressableRule(
          text.split("\n").find((line) =>
            unsuppressableRule(line) !== undefined
          ) ?? "",
        ) !== undefined
      ) {
        offenders.push(file.slice(root.length));
      }
    }
  }
  assertEquals(offenders, []);
});

async function* codeFiles(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await Array.fromAsync(Deno.readDir(directory));
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* codeFiles(`${path}/`);
    } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name)) {
      yield path;
    }
  }
}
