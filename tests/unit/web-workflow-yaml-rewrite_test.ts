import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  decodeWorkflowYaml,
  rewriteWorkflowYaml,
} from "../../packages/contracts/src/workflow-compiler/mod.ts";

const SOURCE = `# Release train
apiVersion: bakery.dev/v1
name: release-train
steps:
  # read the task first
  - id: brief
    uses: task.brief
  - id: build # the long one
    uses: harness.implement
    with:
      tries: 2 # keep low
`;

const brief = { id: "brief", uses: "task.brief" };
const build = { id: "build", uses: "harness.implement", with: { tries: 2 } };
const review = { id: "review", uses: "review.independent" };
const base = { apiVersion: "bakery.dev/v1", name: "release-train" };

function rewritten(steps: readonly unknown[], source = SOURCE): string {
  const definition = { ...base, steps };
  const text = rewriteWorkflowYaml(source, definition);
  assert(text !== null);
  const read = decodeWorkflowYaml(text);
  assert(read.ok);
  assertEquals<unknown>(read.value, definition);
  return text;
}

Deno.test("an unchanged definition keeps the authored text", () => {
  assertEquals(rewritten([brief, build]), SOURCE);
});

Deno.test("moving, adding and changing a step keeps the comments with their steps", () => {
  const text = rewritten([
    { ...build, with: { tries: 3 } },
    review,
    brief,
  ]);
  assertStringIncludes(text, "# Release train");
  assertStringIncludes(text, "- id: build # the long one");
  assertStringIncludes(text, "tries: 3 # keep low");
  assert(text.indexOf("id: build") < text.indexOf("# read the task first"));
  assert(text.indexOf("# read the task first") < text.indexOf("id: brief"));
});

Deno.test("a removed step takes its comment with it", () => {
  const text = rewritten([build]);
  assert(!text.includes("read the task first"));
  assertStringIncludes(text, "# the long one");
});

Deno.test("source the importer refuses is replaced by a plain export", () => {
  const text = rewritten([brief], "steps: [unclosed");
  assertStringIncludes(text, "apiVersion: bakery.dev/v1");
});
