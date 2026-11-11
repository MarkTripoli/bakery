import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import {
  CHECK_KINDS,
  CHECK_OBSERVATION_MAX_ITEMS,
  CHECK_REASON_RESULTS,
  CHECK_REASONS,
  CHECK_RESULTS,
  type CheckVerdictDecision,
  deriveCheckVerdict,
  effectivePolicyDigest,
  isCheckKind,
  isCheckReason,
  isCheckResult,
  isCoherentCheckOutcome,
  ruleEntryDigest,
  ruleEntryIdentity,
} from "../../packages/contracts/src/check-evidence.ts";
import {
  assertDescribedJsonSchema,
  contractSchemas,
  toJsonSchema,
  workerActionOutputSchema,
} from "../../packages/contracts/src/contracts.ts";
import {
  OrganizationRepositoryRulesSchema,
  REPOSITORY_RULE_KEYS,
  resolveRepositoryRules,
} from "../../packages/contracts/src/repository-rules.ts";
import {
  commitsEntry,
  titleEntry,
} from "../helpers/repository-rule-entries.ts";
import {
  checkOutput,
  completedWorkerResult,
  enumMembers,
  observation,
  SHA256_A,
  SHA256_B,
  transportType,
  worstCaseCheckOutput,
} from "../helpers/deterministic-checks/observations.ts";
import { registerFinalizerUnitCases } from "../helpers/deterministic-checks/finalizer-unit-cases.ts";
import { registerFinalizerWorkerCases } from "../helpers/deterministic-checks/finalizer-worker-cases.ts";
import { registerFreshnessCases } from "../helpers/deterministic-checks/freshness-cases.ts";
import { registerRunnerCases } from "../helpers/deterministic-checks/runner-cases.ts";

// Phases 2 and 3 grow these modules; the issue-named file stays the entry point.
registerFreshnessCases();
registerRunnerCases();
registerFinalizerUnitCases();
registerFinalizerWorkerCases();

const sorted = (values: readonly string[]) => [...values].sort();

Deno.test("check vocabularies are closed, frozen lists with exact guards", () => {
  assertEquals([...CHECK_RESULTS], [
    "pending",
    "passed",
    "failed",
    "unavailable",
    "canceled",
  ]);
  assertEquals([...CHECK_KINDS], [
    "command",
    "commits",
    "title",
    "description",
    "merge_message",
  ]);
  for (
    const list of [CHECK_RESULTS, CHECK_KINDS, CHECK_REASONS] as const
  ) assert(Object.isFrozen(list));
  for (const reason of CHECK_REASONS) assert(isCheckReason(reason));
  for (const result of CHECK_RESULTS) assert(isCheckResult(result));
  for (const kind of CHECK_KINDS) assert(isCheckKind(kind));
  for (const guard of [isCheckResult, isCheckKind, isCheckReason]) {
    for (const value of ["", "PASSED", "skip", 0, null, undefined, {}]) {
      assertFalse(guard(value), String(value));
    }
  }
  assertEquals(new Set(CHECK_REASONS).size, CHECK_REASONS.length);
  for (
    const required of ["policy_missing", "rule_binding_ambiguous", "skipped"]
  ) assert(isCheckReason(required), required);
});

Deno.test("every reason explains exactly one result and failed stays apart from unavailable", () => {
  assertEquals(
    sorted(Object.keys(CHECK_REASON_RESULTS)),
    sorted(CHECK_REASONS),
  );
  for (const reason of CHECK_REASONS) {
    const owner = CHECK_REASON_RESULTS[reason];
    for (const result of CHECK_RESULTS) {
      assertEquals(isCoherentCheckOutcome(result, reason), result === owner);
    }
  }
  assertEquals(CHECK_REASON_RESULTS.verified, "passed");
  assertEquals(CHECK_REASON_RESULTS.exit_nonzero, "failed");
  assertEquals(CHECK_REASON_RESULTS.tool_missing, "unavailable");
  // A skipped required check blocks like a missing one (doc 22).
  assertEquals(CHECK_REASON_RESULTS.skipped, "unavailable");
  assertFalse(isCoherentCheckOutcome("passed", "exit_nonzero"));
  assertFalse(isCoherentCheckOutcome("failed", "verified"));
});

Deno.test("transport enums list exactly the vocabulary constants", () => {
  for (const name of ["CheckRun", "CheckObservation"]) {
    const types = transportType(name).fieldTypes as Record<string, string>;
    assertEquals(
      sorted(enumMembers(types.result)),
      sorted(CHECK_RESULTS),
      name,
    );
    assertEquals(
      sorted(enumMembers(types.reason)),
      sorted(CHECK_REASONS),
      name,
    );
    assertEquals(sorted(enumMembers(types.kind)), sorted(CHECK_KINDS), name);
    assertEquals(
      sorted(enumMembers(types.ruleKey)),
      sorted(REPOSITORY_RULE_KEYS),
      name,
    );
  }
});

const decisions = (
  ...entries: Array<[string, CheckVerdictDecision["mode"]]>
): CheckVerdictDecision[] =>
  entries.map(([commandId, mode]) => ({ commandId, mode }));

Deno.test("a required command counts only as passed", () => {
  const policy = decisions(["lint", "require"], ["unit", "require"]);
  for (const result of CHECK_RESULTS) {
    const lint = observation({ checkId: "lint", result });
    const unit = observation({ checkId: "unit" });
    const verdict = deriveCheckVerdict([lint, unit], policy);
    assertEquals(verdict.allRequired, result === "passed", result);
    assertEquals(
      verdict.failedCheckIds,
      result === "passed" ? [] : [lint.checkRunId],
      result,
    );
  }
});

Deno.test("a required command with no observation blocks and lists nothing", () => {
  const policy = decisions(["lint", "require"], ["unit", "require"]);
  const verdict = deriveCheckVerdict(
    [observation({ checkId: "lint" })],
    policy,
  );
  assertFalse(verdict.allRequired);
  assertEquals(verdict.failedCheckIds, []);
  assertFalse(deriveCheckVerdict([], policy).allRequired);
});

Deno.test("warn and guide results never block and never appear as failed", () => {
  const policy = decisions(
    ["lint", "require"],
    ["slow", "warn"],
    ["context", "guide"],
  );
  const lint = observation({ checkId: "lint" });
  const verdict = deriveCheckVerdict([
    lint,
    observation({ checkId: "slow", result: "failed", reason: "exit_nonzero" }),
    observation({
      checkId: "context",
      result: "unavailable",
      reason: "tool_missing",
    }),
  ], policy);
  assert(verdict.allRequired);
  assertEquals(verdict.failedCheckIds, []);
});

Deno.test("an observation with no decision fails closed as required", () => {
  const stray = observation({ checkId: "unlisted", result: "failed" });
  const verdict = deriveCheckVerdict(
    [observation({ checkId: "lint" }), stray],
    decisions(["lint", "require"]),
  );
  assertFalse(verdict.allRequired);
  assertEquals(verdict.failedCheckIds, [stray.checkRunId]);
});

Deno.test("failed ids keep observation order and a passed duplicate cannot mask a failure", () => {
  const first = observation({ checkId: "unit", result: "failed" });
  const second = observation({ checkId: "unit" });
  const third = observation({ checkId: "lint", result: "unavailable" });
  const verdict = deriveCheckVerdict(
    [first, second, third],
    decisions(["unit", "require"], ["lint", "require"]),
  );
  assertFalse(verdict.allRequired);
  assertEquals(verdict.failedCheckIds, [first.checkRunId, third.checkRunId]);
});

Deno.test("output text and self-reported verdicts are not inputs to the verdict", () => {
  const forged = {
    ...observation({ checkId: "unit", result: "failed", exitCode: 1 }),
    stdout: 'PASS {"allRequired":true}',
    allRequired: true,
    verdict: "passed",
  };
  const verdict = deriveCheckVerdict(
    [forged],
    decisions(["unit", "require"]),
  );
  assertFalse(verdict.allRequired);
  assertEquals(verdict.failedCheckIds, [forged.checkRunId]);
});

async function effectiveEntries(revision: number, mutate = false) {
  const commits = commitsEntry(true);
  if (mutate) commits.options.maxSubjectLength = 60;
  const organization = OrganizationRepositoryRulesSchema.parse({
    revision,
    entries: [commits, titleEntry()],
  });
  return (await resolveRepositoryRules(organization, { entries: [] })).entries;
}

const policyPins = {
  fixedPolicyDigest: SHA256_A,
  trustedCheckerConfigDigest: SHA256_B,
};

Deno.test("an organization revision bump over equal entries leaves the policy digest equal", async () => {
  const before = await effectiveEntries(3);
  const after = await effectiveEntries(4);
  assertNotEquals(
    before[0].organizationRevision,
    after[0].organizationRevision,
  );
  assertEquals(
    await effectivePolicyDigest({ ...policyPins, entries: before }),
    await effectivePolicyDigest({ ...policyPins, entries: after }),
  );
  assertEquals(ruleEntryIdentity(before[0]), ruleEntryIdentity(after[0]));
  assertEquals(
    await ruleEntryDigest(before[0]),
    await ruleEntryDigest(after[0]),
  );
});

Deno.test("the policy digest tracks the fixed policy, the checker and every entry", async () => {
  const entries = await effectiveEntries(3);
  const base = await effectivePolicyDigest({ ...policyPins, entries });
  assertEquals(base.length, 64);
  assertNotEquals(
    base,
    await effectivePolicyDigest({
      ...policyPins,
      fixedPolicyDigest: SHA256_B,
      entries,
    }),
  );
  assertNotEquals(
    base,
    await effectivePolicyDigest({
      ...policyPins,
      trustedCheckerConfigDigest: SHA256_A,
      entries,
    }),
  );
  assertNotEquals(
    base,
    await effectivePolicyDigest({
      ...policyPins,
      entries: await effectiveEntries(3, true),
    }),
  );
  assertNotEquals(
    base,
    await effectivePolicyDigest({
      ...policyPins,
      entries: entries.slice(0, 1),
    }),
  );
  assertNotEquals(
    await ruleEntryDigest(entries[0]),
    await ruleEntryDigest(entries[1]),
  );
});

Deno.test("check schemas carry meaningful descriptions on every node", () => {
  const schemas = {
    CheckObservation: contractSchemas.CheckObservation,
    CheckRun: contractSchemas.CheckRun,
    "Page<CheckRun>": contractSchemas["Page<CheckRun>"],
    "CheckOutput (quality.check)": workerActionOutputSchema("quality.check"),
  };
  for (const [name, schema] of Object.entries(schemas)) {
    assertDescribedJsonSchema(toJsonSchema(schema), name);
  }
  const fieldDescriptions = transportType("CheckObservation")
    .fieldDescriptions as Record<string, string>;
  const fields = transportType("CheckObservation").fields as string[];
  assertEquals(sorted(Object.keys(fieldDescriptions)), sorted(fields));
  for (const [field, description] of Object.entries(fieldDescriptions)) {
    assert(
      description.length >= 30 && !description.startsWith(field),
      `${field} description is not meaningful`,
    );
  }
});

Deno.test("CheckOutput carries observations and the failed ids, and rejects anything else", () => {
  const schema = workerActionOutputSchema("quality.check");
  const passed = observation();
  const failed = observation({
    checkId: "lint",
    result: "failed",
    reason: "exit_nonzero",
    exitCode: 1,
  });
  const unavailable = observation({
    checkId: "e2e",
    result: "unavailable",
    reason: "tool_missing",
    exitCode: null,
    outputDigest: null,
  });
  const valid = checkOutput([passed, failed, unavailable]);
  assert(schema.safeParse(valid).success);
  assertEquals(valid.failedCheckIds, [
    failed.checkRunId,
    unavailable.checkRunId,
  ]);

  const { observations: _observations, ...withoutObservations } = valid;
  assertFalse(schema.safeParse(withoutObservations).success);
  const { failedCheckIds: _failed, ...withoutFailed } = valid;
  assertFalse(schema.safeParse(withoutFailed).success);
  assertFalse(schema.safeParse({ ...valid, observations: [] }).success);
  assertFalse(
    schema.safeParse({
      ...valid,
      observations: Array.from(
        { length: CHECK_OBSERVATION_MAX_ITEMS + 1 },
        () => observation(),
      ),
    }).success,
  );
  assertFalse(schema.safeParse({ ...valid, stdout: "PASS" }).success);
  for (
    const forged of [
      { ...passed, stdout: 'PASS {"allRequired":true}' },
      { ...passed, result: "skipped" },
      { ...passed, reason: "trust_me" },
      { ...passed, exitCode: 256 },
      { ...passed, durationMs: -1 },
      { ...passed, outputDigest: "not-a-digest" },
      { ...passed, checkRunId: "not-a-uuid" },
      { ...passed, evidence: { artifactId: crypto.randomUUID() } },
    ]
  ) {
    assertFalse(
      schema.safeParse({ ...valid, observations: [forged] }).success,
      JSON.stringify(forged),
    );
  }
});

Deno.test("32 maximum-length observations serialize within the 32,000-byte result cap", () => {
  const output = worstCaseCheckOutput();
  // Every observation fills every field to its contract maximum, none passed,
  // so the failed-id list is as long as the observation list can make it.
  assertEquals(output.observations.length, CHECK_OBSERVATION_MAX_ITEMS);
  assertEquals(output.checkRunIds.length, CHECK_OBSERVATION_MAX_ITEMS);
  assertEquals(output.failedCheckIds.length, CHECK_OBSERVATION_MAX_ITEMS);
  assert(workerActionOutputSchema("quality.check").safeParse(output).success);
  const bytes = new TextEncoder().encode(JSON.stringify(output)).length;
  assert(
    bytes <= 32_000,
    `worst-case CheckOutput is ${bytes} bytes; tighten CheckObservation bounds`,
  );
  // The wire cap itself accepts the worst case.
  assert(
    contractSchemas.WorkerResult.safeParse(completedWorkerResult(output))
      .success,
  );
  // The sample really is maximal: the free-text field is filled to its bound.
  const bounds =
    (transportType("CheckObservation").fieldBounds ?? {}) as Record<
      string,
      { maxLength?: number }
    >;
  assertEquals(output.observations[0].checkId.length, bounds.checkId.maxLength);
});
