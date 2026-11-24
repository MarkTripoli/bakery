import { assertEquals } from "@std/assert";
import {
  caseGroups,
  caseNamesOf,
  changeLine,
  compareTitle,
  groupOf,
  olderFirst,
  refusalWords,
  scorerLines,
  scorerNamesOf,
  sideLine,
  stillRunning,
  sublineWords,
  unpairedRows,
} from "../../apps/web/src/pages/library/evaluations-compare.ts";

const SCORER_A = "00000000-0000-4000-8000-0000000000a1";
const SCORER_B = "00000000-0000-4000-8000-0000000000b1";
const CASE_1 = "00000000-0000-4000-8000-0000000000c1";
const CASE_2 = "00000000-0000-4000-8000-0000000000c2";
const CASE_3 = "00000000-0000-4000-8000-0000000000c3";

const names = {
  cases: new Map([[CASE_1, "Refund over limit"], [CASE_2, "Refund in euros"], [
    CASE_3,
    "Refund twice",
  ]]),
  scorers: new Map([[SCORER_A, "amount-check"], [SCORER_B, "tone-rubric"]]),
};

Deno.test("a pass rate reads as a percent and the count measured, never a total", () => {
  assertEquals(sideLine({ passRate: 0.8, cases: 10 }), {
    rate: {
      key: "library.evaluations.compare.side.rate",
      values: { rate: 80 },
    },
    measured: {
      key: "library.evaluations.compare.side.measured",
      values: { cases: 10 },
    },
    count: 10,
  });
});

Deno.test("a side that measured nothing says so and has no rate", () => {
  assertEquals(sideLine({ passRate: null, cases: 0 }), {
    rate: { key: "library.evaluations.compare.side.nothing" },
    measured: null,
    count: 0,
  });
});

Deno.test("the change is up, down or none, in points, and never shown without two measured sides", () => {
  const measured = sideLine({ passRate: 0.5, cases: 4 });
  const nothing = sideLine({ passRate: null, cases: 0 });
  assertEquals(changeLine(0.25, measured, measured), {
    words: {
      key: "library.evaluations.compare.change.up",
      values: { points: 25 },
    },
    tone: "success",
  });
  assertEquals(changeLine(-0.1, measured, measured), {
    words: {
      key: "library.evaluations.compare.change.down",
      values: { points: 10 },
    },
    tone: "danger",
  });
  assertEquals(changeLine(0, measured, measured), {
    words: { key: "library.evaluations.compare.change.same" },
    tone: "neutral",
  });
  assertEquals(
    changeLine(0.004, measured, measured).words.key,
    "library.evaluations.compare.change.same",
  );
  assertEquals(changeLine(0.2, nothing, measured), {
    words: { key: "library.evaluations.compare.change.none" },
    tone: "neutral",
  });
  assertEquals(changeLine(null, measured, measured).tone, "neutral");
});

Deno.test("each scorer line carries its name from the run's pins", () => {
  const lines = scorerLines({
    measures: [{
      scorerId: SCORER_A,
      left: { passRate: 0.5, cases: 4 },
      right: { passRate: 0.75, cases: 4 },
      change: 0.25,
    }],
  }, names.scorers);
  assertEquals(lines.length, 1);
  assertEquals(lines[0]?.name, "amount-check");
  assertEquals(lines[0]?.change.tone, "success");
});

Deno.test("a result changes group by what both sides measured", () => {
  assertEquals(groupOf("passed", "failed"), "nowFailing");
  assertEquals(groupOf("failed", "passed"), "nowPassing");
  assertEquals(groupOf("failed", "failed"), "stillFailing");
  assertEquals(groupOf("passed", "passed"), "passingBoth");
  assertEquals(groupOf("passed", "error"), "notMeasured");
  assertEquals(groupOf("missing", "passed"), "notMeasured");
  assertEquals(groupOf("skipped", "canceled"), "notMeasured");
  assertEquals(groupOf("unscored", "failed"), "notMeasured");
});

Deno.test("the groups come in the designed order, rows sorted by case then scorer", () => {
  const groups = caseGroups(
    {
      cases: [
        { caseId: CASE_1, scorerId: SCORER_A, left: "passed", right: "failed" },
        { caseId: CASE_2, scorerId: SCORER_B, left: "passed", right: "failed" },
        { caseId: CASE_2, scorerId: SCORER_A, left: "passed", right: "failed" },
        { caseId: CASE_3, scorerId: SCORER_A, left: "failed", right: "passed" },
        {
          caseId: CASE_3,
          scorerId: SCORER_B,
          left: "missing",
          right: "passed",
        },
      ],
    },
    names,
    { left: false, right: false },
  );
  assertEquals(groups.map((group) => group.id), [
    "nowFailing",
    "nowPassing",
    "notMeasured",
    "stillFailing",
    "passingBoth",
  ]);
  assertEquals(
    groups[0]?.rows.map((row) => `${row.caseName}|${row.scorerName}`),
    [
      "Refund in euros|amount-check",
      "Refund in euros|tone-rubric",
      "Refund over limit|amount-check",
    ],
  );
  assertEquals(groups[2]?.rows[0]?.left, {
    key: "library.evaluations.result.notRunBare",
  });
  assertEquals(groups[3]?.rows, []);
});

Deno.test("a state still going reads Not run yet, not Not run", () => {
  const groups = caseGroups(
    {
      cases: [
        {
          caseId: CASE_1,
          scorerId: SCORER_A,
          left: "passed",
          right: "missing",
        },
      ],
    },
    names,
    { left: false, right: true },
  );
  assertEquals(groups[2]?.rows[0]?.right, {
    key: "library.evaluations.result.notRunYet",
  });
  assertEquals(groups[2]?.rows[0]?.left, {
    key: "library.evaluations.result.passed",
  });
});

Deno.test("an id the names do not know reads as the id, never blank", () => {
  const groups = caseGroups(
    {
      cases: [
        { caseId: CASE_1, scorerId: SCORER_A, left: "passed", right: "failed" },
      ],
    },
    { cases: new Map(), scorers: new Map() },
    { left: false, right: false },
  );
  assertEquals(groups[0]?.rows[0]?.caseName, CASE_1);
  assertEquals(groups[0]?.rows[0]?.scorerName, SCORER_A);
});

Deno.test("cases only one run has are listed by name", () => {
  assertEquals(
    unpairedRows([
      { caseId: CASE_2, scorerId: SCORER_A },
      { caseId: CASE_1, scorerId: SCORER_B },
    ], names),
    [
      {
        caseId: CASE_2,
        caseName: "Refund in euros",
        scorerName: "amount-check",
      },
      {
        caseId: CASE_1,
        caseName: "Refund over limit",
        scorerName: "tone-rubric",
      },
    ],
  );
});

const pin = (version: number) => ({ kind: "workflow", id: "w1", version });

Deno.test("the title names one thing once when both runs measured it", () => {
  assertEquals(
    compareTitle(
      {
        candidate: pin(4),
        candidateDefinition: { definitionId: "d1", name: "Reviewed coding" },
      },
      {
        candidate: pin(5),
        candidateDefinition: { definitionId: "d1", name: "Reviewed coding" },
      },
    ),
    {
      same: true,
      words: {
        key: "library.evaluations.compare.title.same",
        values: { name: "Reviewed coding", a: 4, b: 5 },
      },
    },
  );
});

Deno.test("two different things read as two titles", () => {
  const title = compareTitle(
    {
      candidate: pin(4),
      candidateDefinition: { definitionId: "d1", name: "Reviewed coding" },
    },
    {
      candidate: { kind: "agent", id: "a1", version: 2 },
      candidateDefinition: { definitionId: "d2", name: "Triage" },
    },
  );
  assertEquals(title.same, false);
  if (!title.same) {
    assertEquals(title.left, {
      key: "library.evaluations.title.named",
      values: { name: "Reviewed coding", version: 4 },
    });
    assertEquals(title.right, {
      key: "library.evaluations.title.named",
      values: { name: "Triage", version: 2 },
    });
  }
});

Deno.test("an unnamed thing falls back to its kind and version, in two titles", () => {
  const title = compareTitle(
    { candidate: pin(1), candidateDefinition: null },
    { candidate: pin(2), candidateDefinition: null },
  );
  assertEquals(title.same, false);
});

Deno.test("the line under the title says the set, the cases and the scorers", () => {
  assertEquals(
    sublineWords({ datasetName: "Refund cases" }, {
      measures: [
        {
          scorerId: SCORER_A,
          left: { passRate: 1, cases: 2 },
          right: { passRate: 1, cases: 2 },
          change: 0,
        },
      ],
      cases: [
        { caseId: CASE_1, scorerId: SCORER_A, left: "passed", right: "passed" },
        { caseId: CASE_2, scorerId: SCORER_A, left: "passed", right: "passed" },
      ],
    }),
    {
      key: "library.evaluations.compare.subline",
      values: { set: "Refund cases", cases: 2, scorers: 1 },
    },
  );
});

Deno.test("each refusal has its own words, and the dataset one names both sets", () => {
  const sets = { left: "Refund cases", right: "Billing cases" };
  assertEquals(refusalWords("different_dataset", sets), {
    key: "library.evaluations.compare.refused.dataset",
    values: { a: "Refund cases", b: "Billing cases" },
  });
  assertEquals(
    refusalWords("different_case_revision", sets).key,
    "library.evaluations.compare.refused.caseRevision",
  );
  assertEquals(
    refusalWords("different_scorer_version", sets).key,
    "library.evaluations.compare.refused.scorer",
  );
});

Deno.test("a run still going is named, the right side first", () => {
  assertEquals(
    stillRunning({ state: "completed" }, { state: "running" }),
    "right",
  );
  assertEquals(
    stillRunning({ state: "queued" }, { state: "completed" }),
    "left",
  );
  assertEquals(
    stillRunning({ state: "completed" }, { state: "completed_with_errors" }),
    null,
  );
});

Deno.test("the older run is the left side", () => {
  const older = { createdAt: "2026-11-01T00:00:00.000Z", id: "older" };
  const newer = { createdAt: "2026-11-02T00:00:00.000Z", id: "newer" };
  assertEquals(olderFirst(newer, older), [older, newer]);
  assertEquals(olderFirst(older, newer), [older, newer]);
});

Deno.test("names come from the results and the pins, the first seen winning", () => {
  assertEquals(
    [...caseNamesOf([
      { caseId: CASE_1, caseName: "Refund over limit" },
      { caseId: CASE_1, caseName: "Renamed" },
      { caseId: CASE_2, caseName: "Refund in euros" },
    ])],
    [[CASE_1, "Refund over limit"], [CASE_2, "Refund in euros"]],
  );
  assertEquals(
    [...scorerNamesOf({
      scorers: [{
        scorerId: SCORER_A,
        slug: "amount-check",
        scorerRevision: 1,
        evaluatorType: "deterministic",
        required: true,
      }],
    })],
    [[SCORER_A, "amount-check"]],
  );
});
