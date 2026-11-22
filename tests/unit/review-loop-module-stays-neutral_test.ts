import { assert, assertEquals } from "@std/assert";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { REPOSITORY_RULE_MODES } from "../../packages/contracts/src/repository-rules.ts";
import * as reviewLoop from "../../apps/server/src/modules/review-loop/index.ts";

// #440, chapter 25 section 15.3 and decision O30. The review loop module
// (findings convention, rounds, the progress rule, caps) is neutral: it sits on
// the kernel and never imports the software-delivery pack, so a pack that
// reviews something other than code can use it. This rail keeps it that way:
// a rename is not a boundary, an import rule is.

const root = new URL("../..", import.meta.url).pathname;
const moduleDirectory = join(root, "apps/server/src/modules/review-loop");
const modulesDirectory = join(root, "apps/server/src/modules");

/** The one kernel file the loop reads: it finds the loop's three steps in a frozen spec. */
const ALLOWED_KERNEL_FILES = ["apps/server/src/modules/work/run-steps.ts"];

/** Packs and integrations the neutral module must never reach, however deep. */
const FORBIDDEN_DIRECTORIES = [
  "apps/server/src/modules/delivery/",
  "apps/server/src/modules/integrations/",
];

const FORBIDDEN_WORK = "apps/server/src/modules/work/";

function sourceFiles(): string[] {
  return readdirSync(moduleDirectory).filter((name) =>
    name.endsWith(".ts") && !name.endsWith("_test.ts")
  ).map((name) => join(moduleDirectory, name));
}

/** Every module specifier a file imports, re-exports or imports dynamically. */
function specifiers(text: string): string[] {
  const found: string[] = [];
  const pattern =
    /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(["'`])([^"'`]+)\1/g;
  for (const match of text.matchAll(pattern)) found.push(match[2]!);
  return found;
}

Deno.test("the review loop module imports neither the delivery pack nor integrations", () => {
  const files = sourceFiles();
  assert(files.length > 0, "the review loop module has no source files");
  for (const file of files) {
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) {
        assert(
          !/modules\/(delivery|integrations)\b/.test(specifier),
          `${relative(root, file)} imports ${specifier}`,
        );
        continue;
      }
      const target = relative(root, resolve(dirname(file), specifier))
        .replaceAll(
          "\\",
          "/",
        );
      for (const forbidden of FORBIDDEN_DIRECTORIES) {
        assert(
          !target.startsWith(forbidden),
          `${
            relative(root, file)
          } imports ${specifier}, which is in ${forbidden}`,
        );
      }
      if (target.startsWith(FORBIDDEN_WORK)) {
        assert(
          ALLOWED_KERNEL_FILES.includes(target),
          `${relative(root, file)} imports ${specifier}; only ${
            ALLOWED_KERNEL_FILES.join(", ")
          } may be read from the work module`,
        );
      }
    }
  }
});

Deno.test("the review loop module exports what chapter 25 says it owns, and nothing git-shaped", () => {
  assertEquals(Object.keys(reviewLoop).sort(), [
    "DECISION_REVIEW_STATUSES",
    "FINDINGS_SUB_REASONS",
    "REQUIREMENT_MODES",
    "REQUIREMENT_STATUSES",
    "REVIEW_INDEPENDENCE_VIOLATIONS",
    "REVIEW_NOT_INDEPENDENT_REASON",
    "REVIEW_REPORT_INVALID_REASON",
    "ReportFindingSchema",
    "appendIteration",
    "appendStopGate",
    "assertFindingsLimits",
    "assertIndependentReviewer",
    "decideDelivery",
    "planReviewLoopLimits",
    "planReviewRepeatKey",
    "reviewLoopSteps",
    "verifyFindings",
  ]);
  for (const name of Object.keys(reviewLoop)) {
    assert(
      !/sha|repositor|candidate|commit|merge/i.test(name),
      `${name} carries a repository concept`,
    );
  }
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert(
      !/\b(headSha|baseSha|subject_head_sha|base_sha|repositoryId)\b/.test(
        text,
      ),
      `${relative(root, file)} names a git-only field`,
    );
  }
});

Deno.test("the pack no longer holds the moved files, so delivery imports the module one way", () => {
  for (
    const gone of [
      "repair-loop.ts",
      "independence.ts",
      "plan-review-loop.ts",
      "loop-steps.ts",
      "append-iteration.ts",
    ]
  ) {
    assert(
      !existsSync(join(modulesDirectory, "delivery", gone)),
      `delivery/${gone} must live in review-loop/ and not be left behind as a stub`,
    );
  }
});

Deno.test("the loop reads the same enforcement modes a repository rule has", () => {
  assertEquals([...reviewLoop.REQUIREMENT_MODES], [...REPOSITORY_RULE_MODES]);
});
