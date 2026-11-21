/**
 * #41 on the wire contract: a batch is admitted with optional scorers, and
 * reads back a pin digest, the corpus report, the model budget and, per
 * attempt, what it cost. Unknown and unrun are values of their own, a share
 * with nothing to divide is null, and an unknown cost has no amount.
 */

import { assertEquals, assertFalse } from "@std/assert";
import { contractSchemas } from "../../packages/contracts/src/contracts.ts";

const ID = "6f1d2c3a-4b5e-4f60-8a71-92b3c4d5e6f7";
const AT = "2026-11-21T20:00:00.000Z";

const report = {
  total: 4,
  attempted: 3,
  passed: 1,
  failed: 1,
  unknown: 1,
  unrun: 1,
  interrupted: 1,
  recovered: 0,
  passedOfAttempted: 1 / 3,
  failedOfAttempted: 1 / 3,
  recoveredOfInterrupted: 0,
};

const batch = {
  id: ID,
  datasetId: ID,
  datasetName: "smoke",
  datasetDigest: "d".repeat(64),
  candidate: { kind: "agentVersion", id: ID, version: 2 },
  candidateDefinition: null,
  baseline: null,
  baselineDefinition: null,
  scorers: [{
    scorerId: ID,
    slug: "schema",
    scorerRevision: 1,
    evaluatorType: "deterministic",
    required: true,
  }],
  pinDigest: "a".repeat(64),
  state: "running",
  requiredCount: 4,
  measuredCount: 2,
  counts: {
    passed: 1,
    failed: 1,
    error: 1,
    unscored: 0,
    canceled: 0,
    skipped: 0,
    missing: 1,
  },
  report,
  optionalReport: null,
  budget: {
    limitUsd: "0.100000",
    settledUsd: "0.030000",
    estimatedUsd: "0.010000",
    unknownCount: 1,
    status: "unsettled",
    blocksNewAttempts: true,
  },
  gate: {
    decision: "cannot_be_judged",
    rule: "Every one passed.",
    blockers: [],
  },
  hiddenCount: 0,
  canceledAt: null,
  canceledBy: null,
  completedAt: null,
  createdAt: AT,
  updatedAt: AT,
  version: 1,
};

Deno.test("a batch reads back its pin digest, corpus report and model budget", () => {
  const parsed = contractSchemas.EvaluationBatch.parse(batch);
  assertEquals(parsed.pinDigest, "a".repeat(64));
  assertEquals(parsed.report.unknown, 1);
  assertEquals(parsed.report.unrun, 1);
  assertEquals(parsed.budget.status, "unsettled");
  assertEquals(parsed.optionalReport, null);
  assertEquals(parsed.scorers[0]?.required, true);
});

Deno.test("a share with nothing to divide is null, not zero, and the report has no other values", () => {
  const idle = {
    ...report,
    total: 2,
    attempted: 0,
    passed: 0,
    failed: 0,
    unknown: 0,
    unrun: 2,
    interrupted: 0,
    recovered: 0,
    passedOfAttempted: null,
    failedOfAttempted: null,
    recoveredOfInterrupted: null,
  };
  const parsed = contractSchemas.EvaluationBatch.parse({
    ...batch,
    report: idle,
    optionalReport: idle,
  });
  assertEquals(parsed.report.passedOfAttempted, null);
  assertEquals(parsed.optionalReport?.recoveredOfInterrupted, null);
  assertFalse(
    contractSchemas.EvaluationBatch.safeParse({
      ...batch,
      report: { ...report, unrun: undefined },
    }).success,
    "unrun must be stated, not left out",
  );
});

Deno.test("the budget status is one of four, and no limit is a null limit", () => {
  for (const status of ["none", "within", "exhausted", "unsettled"]) {
    const budget = {
      limitUsd: status === "none" ? null : "1.000000",
      settledUsd: "0.000000",
      estimatedUsd: "0.000000",
      unknownCount: 0,
      status,
      blocksNewAttempts: status === "exhausted" || status === "unsettled",
    };
    assertEquals(
      contractSchemas.EvaluationBatch.safeParse({ ...batch, budget }).success,
      true,
      status,
    );
  }
  assertFalse(
    contractSchemas.EvaluationBatch.safeParse({
      ...batch,
      budget: { ...batch.budget, status: "overspent" },
    }).success,
  );
});

Deno.test("an interrupted attempt and an unknown cost are values; an unknown cost has no amount", () => {
  const attempt = {
    id: ID,
    resultId: ID,
    attemptNo: 1,
    state: "interrupted",
    reason: "The worker stopped.",
    score: null,
    startedAt: AT,
    endedAt: AT,
    traceRef: null,
    usage: { measurement: "unknown", costUsd: null },
    createdAt: AT,
  };
  const parsed = contractSchemas.EvaluationAttempt.parse(attempt);
  assertEquals(parsed.state, "interrupted");
  assertEquals(parsed.usage, { measurement: "unknown", costUsd: null });
  assertEquals(
    contractSchemas.EvaluationAttempt.parse({ ...attempt, usage: null }).usage,
    null,
    "a deterministic check has no usage",
  );
  assertFalse(
    contractSchemas.EvaluationAttempt.safeParse({
      ...attempt,
      usage: { measurement: "guessed", costUsd: null },
    }).success,
  );
});

Deno.test("an admission may name its optional scorers", () => {
  const create = {
    datasetId: ID,
    candidate: { kind: "agentVersion", id: ID, version: 2 },
    scorerIds: [ID],
    optionalScorerIds: [ID],
    budgetLimitUsd: "0.10",
  };
  assertEquals(
    contractSchemas.EvaluationBatchCreate.safeParse(create).success,
    true,
  );
  assertFalse(
    contractSchemas.EvaluationBatchCreate.safeParse({
      ...create,
      optionalScorerIds: ["not-a-uuid"],
    }).success,
  );
});

Deno.test("a run says how much of its spend is estimated and whether new model attempts are held", () => {
  const parsed = contractSchemas.EvaluationBatch.parse(batch);
  assertEquals(parsed.budget.estimatedUsd, "0.010000");
  assertEquals(parsed.budget.blocksNewAttempts, true);
  assertFalse(
    contractSchemas.EvaluationBatch.safeParse({
      ...batch,
      budget: { ...batch.budget, blocksNewAttempts: undefined },
    }).success,
    "the page must be told, not left to infer it",
  );
});

Deno.test("runs can be listed by the digest of what they measured, and a result tells a sampled scorer apart by required", () => {
  assertEquals(
    contractSchemas.EvaluationBatchListQuery.safeParse({
      pinDigest: "a".repeat(64),
      limit: 10,
    }).success,
    true,
  );
  assertEquals(
    contractSchemas.EvaluationBatchListQuery.safeParse({}).success,
    true,
  );
  assertFalse(
    contractSchemas.EvaluationBatchListQuery.safeParse({
      pinDigest: "a".repeat(65),
    })
      .success,
  );
  const result = {
    id: ID,
    batchId: ID,
    role: "candidate",
    caseId: ID,
    caseName: "first",
    caseRevision: 1,
    scorerId: ID,
    scorerRevision: 1,
    repetition: 1,
    required: false,
    state: "missing",
    reason: "Not run yet.",
    score: null,
    outputArtifactVersionId: null,
    attemptCount: 0,
    updatedAt: AT,
  };
  assertEquals(
    contractSchemas.EvaluationBatchResult.parse(result).required,
    false,
  );
});
