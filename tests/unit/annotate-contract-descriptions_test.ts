import { assertEquals, assertStringIncludes } from "@std/assert";
import type { ScoreAnswer } from "../../scripts/lib/typesafe.ts";
import {
  buildRequests,
  changedFields,
  collectFields,
  type ContractDescriptionAnnotationRow,
  type ContractField,
  renderSummary,
  verdictFor,
} from "../../scripts/ci/annotate-contract-descriptions.ts";

function field(
  path: string,
  description: string,
  type = "string",
  nullable = false,
  parent = "schema",
): ContractField {
  return { path, type, nullable, description, parent };
}

function distribution(p0: number, p1: number): ScoreAnswer {
  const p2 = Math.max(0, 1 - p0 - p1);
  return {
    type: "score",
    score: p1 + 2 * p2,
    legend: { "0": "weak", "1": "generic", "2": "specific" },
    probabilities: { "0": p0, "1": p1, "2": p2 },
    confidence: Math.max(p0, p1, p2),
  };
}

Deno.test("verdictFor decides from level mass at the 0.5 and 0.75 boundaries", () => {
  assertEquals(verdictFor(distribution(0.5, 0.1)), "weak");
  assertEquals(verdictFor(distribution(0.49, 0.26)), "generic");
  assertEquals(verdictFor(distribution(0.49, 0.25)), null);
  assertEquals(verdictFor(distribution(0.0, 0.75)), "generic");
  assertEquals(verdictFor(distribution(0.1, 0.1)), null);
  // A 50/50 split between "restates" and "one fact" has low confidence but is
  // certainly not informative; the old confidence gate hid these.
  const split = distribution(0.5, 0.5);
  assertEquals(split.confidence, 0.5);
  assertEquals(verdictFor(split), "weak");
});

Deno.test("collectFields walks named fields and description maps deterministically", () => {
  const fields = collectFields({
    inputs: {
      Thing: {
        fields: [{
          name: "name",
          type: "string",
          description: "A human-readable value.",
        }],
        description: "Input object for Thing.",
      },
    },
    projections: {
      things: {
        fields: ["id", "description"],
        // Field-keyed string maps: a field literally named `description`
        // must not surface as a described node of the map itself.
        fieldTypes: { id: "uuid", description: "string|null" },
        sourceColumns: { id: "id", description: "body_text" },
        computedFields: { description: "coalesce(body_text, '')" },
        nullableFields: ["id"],
        fieldDescriptions: { id: "The stable thing identifier." },
      },
    },
  });

  assertEquals(fields, [
    field("inputs.Thing", "Input object for Thing.", "object", false, "inputs"),
    field(
      "inputs.Thing.name",
      "A human-readable value.",
      "string",
      false,
      "inputs.Thing",
    ),
    field(
      "projections.things.id",
      "The stable thing identifier.",
      "uuid",
      true,
      "projections.things",
    ),
  ]);
});

Deno.test("changedFields keeps additions and changed descriptions only", () => {
  const unchanged = field("schema.unchanged", "unchanged");
  const base = [
    field("schema.changed", "old"),
    unchanged,
    field("schema.removed", "removed"),
  ];
  const head = [
    field("schema.new", "New field meaning"),
    field("schema.changed", "new description"),
    unchanged,
    field("schema.defect", "field"),
  ];

  assertEquals(changedFields(base, head), [
    field("schema.new", "New field meaning"),
    field("schema.changed", "new description"),
  ]);
});

Deno.test("buildRequests creates batches with matching state and question ids", () => {
  const fields = Array.from(
    { length: 17 },
    (_, index) => field(`schema.field${index}`, `Description ${index}`),
  );
  const requests = buildRequests(fields);

  assertEquals(requests.map((request) => request.fields.length), [8, 8, 1]);
  for (const request of requests) {
    assertEquals(
      Object.keys(request.state.fields),
      Object.keys(request.questions),
    );
    for (const id of Object.keys(request.state.fields)) {
      const question = request.questions[id];
      assertEquals(question.type, "score");
      assertStringIncludes(
        String(question.instructions),
        `fields.${id}.description`,
      );
    }
  }
});

Deno.test("renderSummary includes only findings and hardens hostile descriptions", () => {
  const rows: ContractDescriptionAnnotationRow[] = [
    {
      ...field("schema.hostile", "bad | text\r\r# Forged\nsecond\\part"),
      verdict: "weak",
      score: 0.4,
      confidence: 0.9,
    },
    {
      ...field("schema.generic", "Adds a generic fact."),
      verdict: "generic",
      score: 1.2,
      confidence: 0.8,
    },
    {
      ...field("schema.silent", "Specific meaning."),
      verdict: null,
      score: 1.8,
      confidence: 0.9,
    },
  ];
  const summary = renderSummary(rows, 3, {
    inputTokens: 123,
    outputTokens: 45,
    requestCount: 1,
  });

  assertStringIncludes(summary, "Judged 3 of 3 changed descriptions.");
  assertStringIncludes(summary, "weak: 1, generic: 1, silent: 1");
  assertEquals(summary.includes("no weak or generic"), false);
  assertStringIncludes(
    summary,
    "| schema.hostile | bad \\| text # Forged second\\\\part | weak |",
  );
  assertStringIncludes(
    summary,
    "| schema.generic | Adds a generic fact. | generic |",
  );
  assertEquals(summary.includes("schema.silent"), false);
  assertEquals(
    summary.split("\n").filter((line) => line.startsWith("| schema.hostile"))
      .length,
    1,
  );
  assertEquals(summary.includes("\r"), false);
});

Deno.test("renderSummary omits the table when no fields were judged", () => {
  const summary = renderSummary([], 5, {
    capped: true,
    stopReason: "request timed out",
  });

  assertStringIncludes(summary, "Judged 0 of 5 changed descriptions");
  assertEquals(summary.includes("| path | description |"), false);
  assertStringIncludes(
    summary,
    "TypeSafe advisory stopped after 0 descriptions: request timed out",
  );
});

Deno.test("renderSummary reports an all-silent run and audit-mode wording", () => {
  const rows: ContractDescriptionAnnotationRow[] = [
    {
      ...field("schema.a", "Specific meaning."),
      verdict: null,
      score: 1.8,
      confidence: 0.9,
    },
    {
      ...field("schema.b", "Another specific meaning."),
      verdict: null,
      score: 1.9,
      confidence: 0.9,
    },
  ];
  const summary = renderSummary(rows, 2, { audit: true });

  assertStringIncludes(summary, "Judged 2 of 2 descriptions.");
  assertEquals(summary.includes("changed descriptions"), false);
  assertStringIncludes(summary, "weak: 0, generic: 0, silent: 2");
  assertStringIncludes(
    summary,
    "no weak or generic descriptions among the 2 judged",
  );
  assertEquals(summary.includes("| schema."), false);
});
