import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearPathMutations,
  describePathMutations,
  droppedPathMutations,
  MAX_PATH_MUTATIONS,
  mutationSite,
  pathMutations,
  recordPathMutation,
} from "../helpers/path-mutation-log.ts";

// #229: a refused spawn said the PATH changed, never what changed it. These pin
// the recorder that answers the second question, and its bounds, so a report
// stays a handful of one-line facts even when a test loops over PATH.

const mutation = (at: string, previous = "/usr/bin", next?: string) => ({
  at,
  action: next === undefined ? ("delete" as const) : ("set" as const),
  previous,
  next,
  site: "/work/tests/unit/example_test.ts:42",
});

Deno.test("the log starts empty and records in the order the changes happened", () => {
  clearPathMutations();
  assertEquals(pathMutations(), []);
  recordPathMutation(mutation("2026-11-16T00:00:01.000Z"));
  recordPathMutation(mutation("2026-11-16T00:00:02.000Z", "/usr/bin", "/bin"));
  assertEquals(
    pathMutations().map((entry) => entry.at),
    ["2026-11-16T00:00:01.000Z", "2026-11-16T00:00:02.000Z"],
  );
  clearPathMutations();
});

Deno.test("the log is bounded and counts what it dropped", () => {
  clearPathMutations();
  for (let index = 0; index < MAX_PATH_MUTATIONS + 3; index += 1) {
    recordPathMutation(mutation(`2026-11-16T00:00:0${index}.000Z`));
  }
  assertEquals(pathMutations().length, MAX_PATH_MUTATIONS);
  assertEquals(droppedPathMutations(), 3);
  // The newest are kept: the change closest to the refusal is the interesting one.
  assertStringIncludes(describePathMutations(pathMutations(), 3), "00:00:07");
  clearPathMutations();
});

Deno.test("no recorded change prints nothing at all, so a healthy run stays quiet", () => {
  assertEquals(describePathMutations([]), "");
});

Deno.test("a recorded change names its site, the old value and the new one", () => {
  const text = describePathMutations([
    mutation("2026-11-16T00:00:01.000Z", "/usr/bin", "/bin:/usr/bin"),
  ]);
  assertStringIncludes(text, "PATH changes in this process: 1");
  assertStringIncludes(text, "set by /work/tests/unit/example_test.ts:42");
  assertStringIncludes(text, "/usr/bin -> /bin:/usr/bin");
});

Deno.test("a deletion is said to be a deletion, not a set", () => {
  const removal = describePathMutations([
    {
      ...mutation("2026-11-16T00:00:01.000Z"),
      action: "delete",
      next: undefined,
    },
  ]);
  assertStringIncludes(
    removal,
    "removed by /work/tests/unit/example_test.ts:42",
  );
  assertStringIncludes(removal, "/usr/bin -> (unset)");
});

Deno.test("a PATH value cannot break the report: line breaks and controls become one line", () => {
  const text = describePathMutations([
    {
      ...mutation("2026-11-16T00:00:01.000Z", "/usr/bin\n[forged] line"),
      next: "/bin\u0000:/usr/bin",
    },
  ]);
  assertEquals(text.split("\n").length, 2, "the value broke out of its line");
  assert(!text.includes("\u0000"), "a control character survived");
  assert(!text.includes("[forged] line\n"), "an injected line survived");
});

Deno.test("a long PATH value and a long site are cut, not printed whole", () => {
  const long = `/${"directory/".repeat(200)}git`;
  const text = describePathMutations([
    { ...mutation("2026-11-16T00:00:01.000Z", long), site: long, next: long },
  ]);
  assert(text.includes("...(cut)"), "nothing was cut");
  assert(text.length < 4000, `the report was ${text.length} characters`);
});

Deno.test("the site is the first frame outside the recorder and the preload", () => {
  const stack = [
    "Error",
    "    at recordPathMutation (file:///work/tests/helpers/path-mutation-log.ts:88:3)",
    "    at set (file:///work/tests/helpers/temp-cleanup-preload.ts:70:13)",
    "    at someTest (file:///work/tests/unit/example_test.ts:42:5)",
  ].join("\n");
  assertEquals(mutationSite(stack), "/work/tests/unit/example_test.ts:42");
});

Deno.test("a stack with no usable frame says so instead of guessing", () => {
  assertEquals(mutationSite("Error\n    at <anonymous>"), "(unknown)");
  assertEquals(mutationSite(undefined), "(unknown)");
});
