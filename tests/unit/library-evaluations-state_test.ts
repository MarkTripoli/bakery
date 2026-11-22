import { assertEquals } from "@std/assert";
import {
  candidatePin,
  countLines,
  filterCount,
  gateCard,
  gateLine,
  groupByCase,
  pinTitle,
  resultStateFilter,
  resultWords,
  runBadge,
  stateChips,
  statesOfFilter,
} from "../../apps/web/src/pages/library/evaluations-state.ts";
import { libraryTab } from "../../apps/web/src/pages/library/library-state.ts";

const COUNTS = {
  passed: 0,
  failed: 0,
  error: 0,
  unscored: 0,
  canceled: 0,
  skipped: 0,
  missing: 0,
};

function batch(
  state: Parameters<typeof runBadge>[0]["state"],
  decision: "met" | "not_met" | "cannot_be_judged",
  counts: Partial<typeof COUNTS> = {},
  measured = 0,
  required = 10,
) {
  return {
    state,
    gate: { decision, rule: "at least 80% pass", blockers: [] },
    counts: { ...COUNTS, ...counts },
    measuredCount: measured,
    requiredCount: required,
  };
}

Deno.test("the Library opens the Evaluations tab when asked", () => {
  assertEquals(libraryTab("evaluations"), "evaluations");
});

Deno.test("a run that finished with gaps is a warning, never a success", () => {
  const gaps = runBadge(batch("completed_with_errors", "cannot_be_judged", {
    passed: 7,
    missing: 3,
  }, 7));
  assertEquals(gaps.tone, "warning");
  assertEquals(gaps.words.key, "library.evaluations.badge.gaps");
  assertEquals(gaps.words.values, { measured: 7, required: 10 });
});

Deno.test("a finished run is green only when its gate is met, red when it is not met", () => {
  const met = runBadge(batch("completed", "met", { passed: 9, failed: 1 }, 10));
  const notMet = runBadge(
    batch("completed", "not_met", { passed: 5, failed: 5 }, 10),
  );
  assertEquals(met.tone, "success");
  assertEquals(notMet.tone, "danger");
  assertEquals(notMet.words.values, { passed: 5, required: 10 });
});

Deno.test("waiting, running, stopped and failed runs read as their own states", () => {
  assertEquals(
    runBadge(batch("queued", "cannot_be_judged")).words.key,
    "library.evaluations.badge.queued",
  );
  assertEquals(
    runBadge(batch("running", "cannot_be_judged", {}, 4)).tone,
    "information",
  );
  assertEquals(
    runBadge(batch("canceled", "cannot_be_judged", {}, 4)).tone,
    "neutral",
  );
  assertEquals(runBadge(batch("failed", "cannot_be_judged")).tone, "danger");
});

Deno.test("the gate is judged when the run ends while it is live", () => {
  assertEquals(
    gateLine(batch("running", "cannot_be_judged")).key,
    "library.evaluations.gate.line.pending",
  );
  assertEquals(
    gateLine(batch("completed", "met")).key,
    "library.evaluations.gate.line.met",
  );
  assertEquals(
    gateCard(batch("running", "cannot_be_judged")).title.key,
    "library.evaluations.gate.pending.title",
  );
  assertEquals(gateCard(batch("running", "cannot_be_judged")).icon, "clock");
  assertEquals(gateCard(batch("completed", "met")).icon, undefined);
});

Deno.test("a gate that cannot be judged is grey and says it is not a pass, and offers the unmeasured results", () => {
  const card = gateCard(batch("completed_with_errors", "cannot_be_judged", {
    passed: 7,
    missing: 3,
  }, 7));
  assertEquals(card.tone, "neutral");
  assertEquals(card.body.values, {
    count: 3,
    required: 10,
    rule: "at least 80% pass",
  });
  assertEquals(card.show, { count: 3, state: "missing" });
  assertEquals(card.spread, null);
});

Deno.test("an error and a result never scored are one group, so one state button names both", () => {
  const card = gateCard(batch("completed_with_errors", "cannot_be_judged", {
    passed: 7,
    error: 1,
    unscored: 2,
  }, 7));
  assertEquals(card.show, { count: 3, state: "notScored" });
  assertEquals(card.spread, null);
});

Deno.test("unmeasured results in several states get no button, and the card lists them", () => {
  const card = gateCard(batch("completed_with_errors", "cannot_be_judged", {
    passed: 7,
    missing: 2,
    canceled: 1,
  }, 7));
  assertEquals(card.show, null);
  assertEquals(card.body.key, "library.evaluations.gate.cannot.bodyMany");
  assertEquals(card.body.values, {
    count: 3,
    required: 10,
    rule: "at least 80% pass",
  });
  assertEquals(card.spread, [
    { state: "missing", count: 2 },
    { state: "canceled", count: 1 },
  ]);
});

Deno.test("a gate that is not met is a warning that shows the failed results", () => {
  const notMet = batch("completed", "not_met", { passed: 6, failed: 4 }, 10);
  const card = gateCard({
    ...notMet,
    gate: {
      ...notMet.gate,
      blockers: [
        { caseId: "a", scorerId: "s", state: "failed" },
        { caseId: "b", scorerId: "s", state: "failed" },
      ],
    },
  });
  assertEquals(card.tone, "warning");
  assertEquals(card.show, { count: 2, state: "failed" });
  assertEquals(
    gateCard(batch("completed", "met", { passed: 10 }, 10)).tone,
    "success",
  );
});

Deno.test("the six counts always add up to the required count", () => {
  const lines = countLines({
    passed: 4,
    failed: 2,
    error: 1,
    unscored: 1,
    canceled: 1,
    skipped: 0,
    missing: 1,
  });
  assertEquals(lines.map((line) => line.id), [
    "passed",
    "failed",
    "notScored",
    "notRun",
    "stopped",
    "skipped",
  ]);
  assertEquals(lines.reduce((sum, line) => sum + line.count, 0), 10);
  assertEquals(lines[2].count, 2);
});

Deno.test(
  "only kinds of result that have any get a chip, in a fixed order; the two scoring states share one",
  () => {
    assertEquals(
      stateChips({ ...COUNTS, failed: 2, missing: 1, error: 1, unscored: 2 }),
      [
        { state: "failed", count: 2 },
        { state: "notScored", count: 3 },
        { state: "missing", count: 1 },
      ],
    );
    assertEquals(statesOfFilter("notScored"), ["error", "unscored"]);
    assertEquals(statesOfFilter("failed"), ["failed"]);
    assertEquals(
      filterCount({ ...COUNTS, error: 1, unscored: 2 }, "notScored"),
      3,
    );
    assertEquals(resultStateFilter("notScored"), "notScored");
    assertEquals(resultStateFilter("error"), null);
    assertEquals(resultStateFilter("nonsense"), null);
  },
);

Deno.test("a pin is read as a kind, an id and a version, and anything else is other", () => {
  assertEquals(candidatePin({ kind: "agentVersion", id: "x", version: 2 }), {
    kind: "agent",
    id: "x",
    version: 2,
  });
  assertEquals(
    candidatePin({ kind: "workflowVersion", id: "y", version: 1 }).kind,
    "workflow",
  );
  assertEquals(candidatePin("text"), {
    kind: "other",
    id: null,
    version: null,
  });
  assertEquals(candidatePin(null).version, null);
});

Deno.test("a run's title uses the definition's name the server gives, else the kind and the version", () => {
  assertEquals(
    pinTitle({ kind: "agentVersion", id: "a1", version: 5 }, {
      name: "Reviewer",
    }),
    {
      key: "library.evaluations.title.named",
      values: { name: "Reviewer", version: 5 },
    },
  );
  assertEquals(
    pinTitle({ kind: "workflowVersion", id: "w1", version: 2 }, {
      name: "Reviewed coding",
    }).values,
    { name: "Reviewed coding", version: 2 },
  );
  // The pin names nothing the server can resolve: the name is null.
  assertEquals(
    pinTitle({ kind: "agentVersion", id: "unknown", version: 3 }, {
      name: null,
    }),
    { key: "library.evaluations.title.agent", values: { version: 3 } },
  );
  assertEquals(
    pinTitle({ kind: "workflowVersion", id: "w9", version: 4 }, null),
    { key: "library.evaluations.title.workflow", values: { version: 4 } },
  );
  assertEquals(
    pinTitle({ kind: "x" }, null).key,
    "library.evaluations.title.unknown",
  );
});

Deno.test("an error or unscored result is never a score of zero, and a missing one says it was not run", () => {
  assertEquals(
    resultWords({ state: "error", reason: "The model timed out." }, false),
    {
      key: "library.evaluations.result.notScored",
      values: { reason: "The model timed out." },
    },
  );
  assertEquals(
    resultWords({ state: "unscored", reason: null }, false).key,
    "library.evaluations.result.notScoredBare",
  );
  assertEquals(
    resultWords({ state: "missing", reason: null }, true).key,
    "library.evaluations.result.notRunYet",
  );
  assertEquals(
    resultWords({ state: "missing", reason: "No machine was free." }, false)
      .key,
    "library.evaluations.result.notRun",
  );
  assertEquals(
    resultWords({ state: "skipped", reason: "Not needed." }, false).values,
    { reason: "Not needed." },
  );
  assertEquals(
    resultWords({ state: "canceled", reason: null }, false).key,
    "library.evaluations.result.stopped",
  );
});

Deno.test("results group by test case on the candidate side only, in server order", () => {
  const row = (id: string, caseId: string, role: "candidate" | "baseline") => ({
    id,
    batchId: "b",
    role,
    caseId,
    caseName: `Case ${caseId}`,
    caseRevision: 1,
    scorerId: "s",
    scorerRevision: 1,
    repetition: 1,
    required: true,
    state: "passed" as const,
    reason: null,
    score: 1,
    outputArtifactVersionId: null,
    attemptCount: 1,
    updatedAt: "2026-11-21T00:00:00.000Z",
  });
  const groups = groupByCase([
    row("1", "c1", "candidate"),
    row("2", "c1", "baseline"),
    row("3", "c2", "candidate"),
    row("4", "c1", "candidate"),
  ]);
  assertEquals(groups.map((group) => group.caseId), ["c1", "c2"]);
  assertEquals(groups.map((group) => group.caseName), ["Case c1", "Case c2"]);
  assertEquals(groups[0].results.map((result) => result.id), ["1", "4"]);
});

Deno.test("an interrupted attempt reads as not scored, with its reason", () => {
  assertEquals(
    resultWords({ state: "interrupted", reason: "The worker stopped." }, false),
    {
      key: "library.evaluations.result.notScored",
      values: { reason: "The worker stopped." },
    },
  );
  assertEquals(
    resultWords({ state: "interrupted", reason: null }, false).key,
    "library.evaluations.result.notScoredBare",
  );
});
