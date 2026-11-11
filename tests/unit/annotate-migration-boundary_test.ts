import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ChoiceAnswer } from "../../scripts/lib/typesafe.ts";
import {
  type BoundaryAnnotationRow,
  flag,
  renderSummary,
} from "../../scripts/ci/annotate-migration-boundary.ts";

function kind(choice: string, confidence: number): ChoiceAnswer {
  return {
    type: "choice",
    choice,
    probabilities: { [choice]: 1 },
    confidence,
  };
}

function row(
  railBehavior: string | null,
  pStructural: number,
  choice = "behavior",
  confidence = 0.9,
  file = "apps/server/src/modules/work/migrations/bakery/0001_test.sql",
  index = 0,
  pRls = 0,
): BoundaryAnnotationRow {
  return {
    file,
    index,
    railBehavior,
    pStructural,
    pRls,
    kind: kind(choice, confidence),
  };
}

Deno.test("flag applies strict structural probability boundaries", () => {
  assertEquals(
    flag(row(null, 0.29)),
    "rail passed but this looks like behavior — check forbiddenPatterns",
  );
  assertEquals(flag(row(null, 0.30)), null);
  assertEquals(
    flag(row("CHECK constraint", 0.81)),
    'rail failed on "CHECK constraint" — keyword inside a literal or comment?',
  );
  assertEquals(flag(row("CHECK constraint", 0.80)), null);
});

Deno.test("flag reports low confidence only between disagreement branches", () => {
  assertEquals(flag(row(null, 0.7, "behavior", 0.59)), "low confidence (0.59)");
  assertEquals(flag(row(null, 0.7, "behavior", 0.60)), null);
});

Deno.test("renderSummary includes only flagged rows and reports totals", () => {
  const summary = renderSummary(
    [
      row(null, 0.29, "behavior", 0.9, "first.sql", 0),
      row(null, 0.7, "structural", 0.9, "second.sql", 1),
      row("CHECK constraint", 0.7, "behavior", 0.9, "third.sql", 2),
    ],
    3,
    3,
    { inputTokens: 123, outputTokens: 45 },
  );

  assertStringIncludes(summary, "Annotated 3 of 3 statements across 3 files");
  assertStringIncludes(summary, "| first.sql | 0 | pass | 0.29 |");
  assertStringIncludes(summary, "| flag |");
  assertEquals(summary.includes("second.sql"), false);
  assertEquals(summary.includes("third.sql"), false);
  assertEquals(summary.includes("no disagreements"), false);
});

Deno.test("flag reports row-level security at its probability boundary", () => {
  assertEquals(
    flag(row(null, 0.7, "structural", 0.9, "rls.sql", 0, 0.49)),
    null,
  );
  assertEquals(
    flag(row(null, 0.7, "structural", 0.9, "rls.sql", 0, 0.5)),
    "rail passed but p(rls)=0.50 — looks like row-level security",
  );
  assertEquals(
    flag(row("CHECK constraint", 0.7, "structural", 0.9, "rls.sql", 0, 0.9)),
    null,
  );
});

Deno.test("renderSummary describes partial and complete annotation runs", () => {
  const partial = renderSummary(
    [
      row(null, 0.7, "structural", 0.9, "first.sql", 0),
      row(null, 0.7, "structural", 0.9, "second.sql", 1),
    ],
    5,
    3,
    { stopReason: "request timed out" },
  );
  assertStringIncludes(
    partial,
    "Rail remains the gate. Annotated 2 of 5 statements across 3 files.",
  );
  assertStringIncludes(
    partial,
    "no disagreements in the 2 annotated statements",
  );
  assertStringIncludes(
    partial,
    "TypeSafe advisory stopped after 2 statements: request timed out",
  );

  const complete = renderSummary(
    [
      row(null, 0.7, "structural", 0.9, "first.sql", 0),
      row(null, 0.7, "structural", 0.9, "second.sql", 1),
      row(null, 0.7, "structural", 0.9, "third.sql", 2),
    ],
    3,
    3,
  );
  assertStringIncludes(complete, "no disagreements");
  assertEquals(complete.includes("no disagreements in"), false);
});

Deno.test("renderSummary hardens hostile file-path cells", () => {
  const summary = renderSummary(
    [row(null, 0.29, "behavior", 0.9, "migration|file\r\r# Forged\\name.sql")],
    1,
    1,
  );
  const tableRows = summary.split("\n").filter((line) =>
    line.startsWith("| migration")
  );
  assertEquals(tableRows.length, 1);
  assertEquals(tableRows[0].includes("\r"), false);
  assertStringIncludes(
    tableRows[0],
    "| migration\\|file # Forged\\\\name.sql |",
  );
});
