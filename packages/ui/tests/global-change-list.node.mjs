import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (name) =>
  readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8");

// Path predicates of a `.some((path) => a || b || ...)` block, normalised.
function predicates(source, startMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `marker not found: ${startMarker}`);
  const end = source.indexOf(");", start);
  const block = source.slice(start + startMarker.length, end);
  return block.split("||").map((part) => part.replace(/\s+/g, " ").trim());
}

test("enterprise global-change list equals capture-stories.mjs's", () => {
  const stories = predicates(
    read("capture-stories.mjs"),
    "const globalChange = paths.some((path) =>",
  );
  const enterprise = predicates(
    read("capture-enterprise.mjs"),
    "  ).some((path) =>",
  );
  assert.ok(stories.length > 10, "capture-stories list parsed");
  assert.deepEqual(
    enterprise,
    stories,
    "capture-enterprise.mjs isGlobalChange drifted from capture-stories.mjs globalChange",
  );
});
