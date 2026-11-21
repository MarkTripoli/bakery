/**
 * #41 on the pure core: pinned versions, the optional-scorer rule and the
 * offline corpus report. AC1: the same pins give the same digest and the same
 * deterministic outcome. AC2: a required check is never optional and an
 * unmeasured result is never counted as a pass. AC3: unknown and unrun stay
 * apart from zero, and an interrupted result that recovers is counted once.
 */

import { assertEquals } from "@std/assert";
import {
  budgetReport,
  checkSpecOf,
  corpusReport,
  formatMicroUsd,
  LOCAL_RUN_SKIP_BASELINE,
  LOCAL_RUN_SKIP_MODEL,
  localRunStep,
  modelAttemptAllowed,
  optionalScorerProblem,
  pinSpec,
  type ReportFact,
  resultStateOfAttempt,
  toMicroUsd,
  usageGroupOf,
  validatePin,
} from "../../apps/server/src/modules/evaluations/domain.ts";
import { canonical } from "../../apps/server/src/modules/evaluations/store.ts";

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";

Deno.test("AC1: a pin names one exact version and nothing else", () => {
  const ok = validatePin({ kind: "agentVersion", id: ID, version: 3 });
  assertEquals(ok, {
    ok: true,
    pin: { kind: "agentVersion", id: ID, version: 3 },
  });
  for (
    const kind of [
      "workflowVersion",
      "skillVersion",
      "profileVersion",
      "artifactVersion",
    ]
  ) {
    assertEquals(validatePin({ kind, id: ID, version: 1 }).ok, true, kind);
  }
  const refused = (pin: unknown) => {
    const result = validatePin(pin);
    return result.ok ? "ok" : result.reason;
  };
  assertEquals(refused(null), "pin_not_an_object");
  assertEquals(refused([]), "pin_not_an_object");
  assertEquals(
    refused({ kind: "agent", id: ID, version: 1 }),
    "pin_kind_unknown",
  );
  assertEquals(
    refused({ kind: "agentVersion", id: "x", version: 1 }),
    "pin_id_invalid",
  );
  assertEquals(
    refused({ kind: "agentVersion", id: ID }),
    "pin_version_required",
  );
  assertEquals(
    refused({ kind: "agentVersion", id: ID, version: 0 }),
    "pin_version_required",
  );
  assertEquals(
    refused({ kind: "agentVersion", id: ID, version: 1.5 }),
    "pin_version_required",
  );
  assertEquals(
    refused({ kind: "agentVersion", id: ID, version: 1, latest: true }),
    "pin_unknown_field",
  );
});

const base = {
  datasetDigest: "d1",
  candidate: { kind: "agentVersion", id: ID, version: 3 },
  baseline: null,
  scorers: [
    { scorerId: "b", scorerRevision: 2, required: true },
    { scorerId: "a", scorerRevision: 1, required: false },
  ],
  repetitions: 1,
};

Deno.test("AC1: the same pins give the same canonical spec whatever the order, and any change gives another", () => {
  const same = canonical(pinSpec(base));
  assertEquals(
    canonical(pinSpec({ ...base, scorers: [...base.scorers].reverse() })),
    same,
  );
  assertEquals(
    canonical(pinSpec({
      ...base,
      candidate: { version: 3, id: ID, kind: "agentVersion" },
    })),
    same,
  );
  const differs = [
    { ...base, datasetDigest: "d2" },
    { ...base, candidate: { ...base.candidate, version: 4 } },
    { ...base, baseline: base.candidate },
    { ...base, repetitions: 2 },
    {
      ...base,
      scorers: [
        { scorerId: "b", scorerRevision: 3, required: true },
        base.scorers[1]!,
      ],
    },
    {
      ...base,
      scorers: [
        base.scorers[0]!,
        { scorerId: "a", scorerRevision: 1, required: true },
      ],
    },
  ];
  for (const other of differs) {
    assertEquals(canonical(pinSpec(other)) === same, false);
  }
});

Deno.test("AC2: only a pinned model scorer can be optional; a deterministic check is always required", () => {
  const scorers = [
    { scorerId: "check", evaluatorType: "deterministic" },
    { scorerId: "judge", evaluatorType: "model" },
  ];
  assertEquals(optionalScorerProblem(scorers, []), null);
  assertEquals(optionalScorerProblem(scorers, ["judge"]), null);
  assertEquals(optionalScorerProblem(scorers, ["check"]), {
    field: "optionalScorerIds",
    reason: "deterministic_scorer_required",
  });
  assertEquals(optionalScorerProblem(scorers, ["other"]), {
    field: "optionalScorerIds",
    reason: "optional_scorer_not_pinned",
  });
  assertEquals(optionalScorerProblem(scorers, ["judge", "judge"]), {
    field: "optionalScorerIds",
    reason: "duplicate_scorer",
  });
});

const fact = (
  state: ReportFact["state"],
  attempts: number,
  interrupted = false,
): ReportFact => ({ state, attempts, interrupted });

Deno.test("AC3: unknown and unrun are counted apart from failed, and shares are never a made-up zero", () => {
  const report = corpusReport([
    fact("passed", 1),
    fact("passed", 2),
    fact("failed", 1),
    fact("error", 1),
    fact("unscored", 1),
    fact("missing", 0),
    fact("canceled", 0),
  ]);
  assertEquals(report.total, 7);
  assertEquals(
    [
      report.attempted,
      report.passed,
      report.failed,
      report.unknown,
      report.unrun,
    ],
    [5, 2, 1, 2, 2],
  );
  assertEquals(report.passedOfAttempted, 2 / 5);
  assertEquals(report.failedOfAttempted, 1 / 5);
  assertEquals(
    report.passed + report.failed + report.unknown,
    report.attempted,
  );
  assertEquals(report.attempted + report.unrun, report.total);
  // Nothing attempted: no share, not zero.
  const idle = corpusReport([fact("missing", 0), fact("missing", 0)]);
  assertEquals(
    [
      idle.attempted,
      idle.unrun,
      idle.passedOfAttempted,
      idle.failedOfAttempted,
    ],
    [0, 2, null, null],
  );
  assertEquals(corpusReport([]).passedOfAttempted, null);
});

Deno.test("AC3: of the interrupted results, the share that recovered to a measurement", () => {
  const report = corpusReport([
    fact("passed", 2, true),
    fact("failed", 2, true),
    fact("error", 2, true),
    fact("passed", 1),
  ]);
  assertEquals([report.interrupted, report.recovered], [3, 2]);
  assertEquals(report.recoveredOfInterrupted, 2 / 3);
  assertEquals(corpusReport([fact("passed", 1)]).recoveredOfInterrupted, null);
  // An interrupted result still waiting is attempted and unknown, not recovered.
  const waiting = corpusReport([fact("error", 1, true)]);
  assertEquals([
    waiting.unknown,
    waiting.recovered,
    waiting.recoveredOfInterrupted,
  ], [
    1,
    0,
    0,
  ]);
});

Deno.test("an interrupted attempt leaves its result an error; every other state is its own", () => {
  assertEquals(resultStateOfAttempt("interrupted"), "error");
  for (
    const state of [
      "passed",
      "failed",
      "error",
      "unscored",
      "canceled",
    ] as const
  ) {
    assertEquals(resultStateOfAttempt(state), state);
  }
});

Deno.test("AC3: a cost is whole micro-dollars and survives a round trip, and a bad amount is not a number", () => {
  assertEquals(toMicroUsd("0.030000"), 30_000);
  assertEquals(toMicroUsd("12"), 12_000_000);
  assertEquals(toMicroUsd(" 1.5 "), 1_500_000);
  assertEquals(toMicroUsd(null), null);
  for (const bad of ["", "-1", "1e3", "abc", "1.", ".5"]) {
    assertEquals(toMicroUsd(bad), null, bad);
  }
  assertEquals(formatMicroUsd(30_000), "0.030000");
  assertEquals(formatMicroUsd(toMicroUsd("199.999999")!), "199.999999");
});

Deno.test("AC3: unknown cost is not zero: it counts on its own and keeps the batch from saying it is within its limit", () => {
  const none = budgetReport(null, [
    { measurement: "reported", count: 2, costUsd: "0.300000" },
  ]);
  assertEquals(none, {
    limitUsd: null,
    settledUsd: "0.300000",
    estimatedUsd: "0.000000",
    unknownCount: 0,
    status: "none",
    blocksNewAttempts: false,
    oldestUnknownAt: null,
  });
  const within = budgetReport("1", [
    { measurement: "reported", count: 2, costUsd: "0.300000" },
    { measurement: "estimated", count: 1, costUsd: "0.100000" },
  ]);
  assertEquals([within.settledUsd, within.status, within.unknownCount], [
    "0.400000",
    "within",
    0,
  ]);
  // One unknown: settled is unchanged (not zero-filled), and the status is unsettled.
  const unsettled = budgetReport("1", [
    { measurement: "reported", count: 1, costUsd: "0.400000" },
    { measurement: "unknown", count: 1, costUsd: null },
  ]);
  assertEquals(
    [unsettled.settledUsd, unsettled.unknownCount, unsettled.status],
    [
      "0.400000",
      1,
      "unsettled",
    ],
  );
  // Over the limit wins over unknown; exactly at the limit is exhausted.
  assertEquals(
    budgetReport("0.4", [
      { measurement: "reported", count: 1, costUsd: "0.400000" },
      { measurement: "unknown", count: 3, costUsd: null },
    ]).status,
    "exhausted",
  );
  // Nothing spent and nothing unknown is within, not unsettled.
  assertEquals(budgetReport("5", []).status, "within");
});

Deno.test("AC2: another model attempt starts only while the batch is provably within its limit", () => {
  const allowed = (
    limit: string | null,
    groups: Parameters<typeof budgetReport>[1],
  ) => modelAttemptAllowed(budgetReport(limit, groups));
  assertEquals(allowed(null, []), true);
  assertEquals(allowed("1", []), true);
  assertEquals(
    allowed("1", [{ measurement: "reported", count: 1, costUsd: "0.5" }]),
    true,
  );
  assertEquals(
    allowed("1", [{ measurement: "reported", count: 1, costUsd: "1" }]),
    false,
  );
  assertEquals(
    allowed("1", [{ measurement: "unknown", count: 1, costUsd: null }]),
    false,
  );
  // A batch with no limit is not stopped by an unknown cost.
  assertEquals(
    allowed(null, [{ measurement: "unknown", count: 1, costUsd: null }]),
    true,
  );
});

Deno.test("AC3: a deterministic check has no usage; a model attempt with no ledger row is unknown, never free", () => {
  assertEquals(usageGroupOf("deterministic", null), null);
  assertEquals(usageGroupOf("model", null), {
    measurement: "unknown",
    costUsd: null,
  });
  assertEquals(
    usageGroupOf("model", { measurement: "reported", costUsd: "0.01" }),
    {
      measurement: "reported",
      costUsd: "0.01",
    },
  );
});

Deno.test("AC1: a scorer config is a check with a known kind, or a reason it is not", () => {
  assertEquals(
    checkSpecOf({ kind: "contains", config: { substring: "ok" } }),
    { ok: true, spec: { kind: "contains", config: { substring: "ok" } } },
  );
  for (const kind of ["json_schema", "equals"]) {
    assertEquals(checkSpecOf({ kind, config: {} }).ok, true, kind);
  }
  for (
    const bad of [null, "x", [], { check: "schema" }, {
      kind: "regex",
      config: {},
    }]
  ) {
    assertEquals(checkSpecOf(bad).ok, false, JSON.stringify(bad));
  }
});

Deno.test("AC2: a local run checks the candidate's deterministic results and skips the rest, never replacing a check with an opinion", () => {
  assertEquals(
    localRunStep({ role: "candidate", evaluatorType: "deterministic" }),
    {
      action: "check",
    },
  );
  assertEquals(localRunStep({ role: "candidate", evaluatorType: "model" }), {
    action: "skip",
    reason: LOCAL_RUN_SKIP_MODEL,
  });
  assertEquals(
    localRunStep({ role: "baseline", evaluatorType: "deterministic" }),
    {
      action: "skip",
      reason: LOCAL_RUN_SKIP_BASELINE,
    },
  );
  assertEquals(
    localRunStep({ role: "baseline", evaluatorType: "model" }).action,
    "skip",
  );
});

Deno.test("an estimate is shown apart from a bill, and the report says whether new model attempts are held", () => {
  const mixed = budgetReport("1", [
    { measurement: "reported", count: 2, costUsd: "0.300000" },
    { measurement: "estimated", count: 1, costUsd: "0.100000" },
    { measurement: "estimated", count: 1, costUsd: "0.050000" },
  ]);
  assertEquals(
    [mixed.settledUsd, mixed.estimatedUsd, mixed.blocksNewAttempts],
    [
      "0.450000",
      "0.150000",
      false,
    ],
  );
  assertEquals(budgetReport("1", []).estimatedUsd, "0.000000");
  // Exhausted and unsettled hold new attempts; none and within do not.
  const held = (
    limit: string | null,
    groups: Parameters<typeof budgetReport>[1],
  ) => budgetReport(limit, groups).blocksNewAttempts;
  assertEquals(held(null, []), false);
  assertEquals(held("1", []), false);
  assertEquals(
    held("1", [{ measurement: "estimated", count: 1, costUsd: "1" }]),
    true,
  );
  assertEquals(
    held("1", [{ measurement: "unknown", count: 1, costUsd: null }]),
    true,
  );
  assertEquals(
    held(null, [{ measurement: "unknown", count: 1, costUsd: null }]),
    false,
  );
});

Deno.test("an unknown cost says since when it has been unknown: the earliest, and null when none is", () => {
  const report = budgetReport("1", [
    {
      measurement: "unknown",
      count: 1,
      costUsd: null,
      since: "2026-11-21T10:42:00.000Z",
    },
    {
      measurement: "unknown",
      count: 2,
      costUsd: null,
      since: "2026-11-21T09:15:00.000Z",
    },
    {
      measurement: "reported",
      count: 1,
      costUsd: "0.1",
      since: "2026-11-21T08:00:00.000Z",
    },
  ]);
  assertEquals(report.oldestUnknownAt, "2026-11-21T09:15:00.000Z");
  assertEquals(report.unknownCount, 3);
  assertEquals(
    budgetReport("1", [{ measurement: "reported", count: 1, costUsd: "0.1" }])
      .oldestUnknownAt,
    null,
  );
});
