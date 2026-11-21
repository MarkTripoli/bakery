/**
 * #41 on the pure core: pinned versions, the optional-scorer rule and the
 * offline corpus report. AC1: the same pins give the same digest and the same
 * deterministic outcome. AC2: a required check is never optional and an
 * unmeasured result is never counted as a pass. AC3: unknown and unrun stay
 * apart from zero, and an interrupted result that recovers is counted once.
 */

import { assertEquals } from "@std/assert";
import {
  corpusReport,
  optionalScorerProblem,
  pinSpec,
  type ReportFact,
  resultStateOfAttempt,
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
