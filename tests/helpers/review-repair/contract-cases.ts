import {
  assert,
  assertEquals,
  assertFalse,
  assertNotEquals,
} from "@std/assert";
import {
  CHECK_REASONS,
  CHECK_RESULTS,
} from "../../../packages/contracts/src/check-evidence.ts";
import {
  assertDescribedJsonSchema,
  catalogActions,
  contractSchemas,
  registeredWorkerActionInputSchema,
  toJsonSchema,
  workerActionCapabilities,
  workerActionCapabilityNames,
  workerActionOutputCarriesSession,
  workerActionOutputSchema,
} from "../../../packages/contracts/src/contracts.ts";
import { descriptionDefectKind } from "../../../packages/contracts/src/description-quality.ts";
import {
  workflowRuntimeImplementedActions,
} from "../../../packages/contracts/src/implemented-actions.ts";
import {
  REPOSITORY_FIXED_POLICY_ACTION_EFFECTS,
  RepositoryFixedPolicyDraftSchema,
  RepositoryPolicyEffectSchema,
} from "../../../packages/contracts/src/repository-profile-config.ts";
import {
  DELIVERY_DECISION_REASONS,
  DELIVERY_DECISIONS,
  DELIVERY_GATE_STEP_KEY,
  DELIVERY_LOOP_STOPPED_CODE,
  DELIVERY_REASON_DECISIONS,
  findingFingerprint,
  fitFindingsToBudget,
  isBlockingSeverity,
  isCoherentDeliveryDecision,
  isDeliveryDecision,
  isDeliveryDecisionReason,
  isReviewLoopSpec,
  isReviewSeverity,
  normalizeFindingKey,
  REPAIR_FAILED_CHECKS_MAX_ITEMS,
  REVIEW_EVIDENCE_MAX_ITEMS,
  REVIEW_FINDING_DETAIL_MAX_LENGTH,
  REVIEW_FINDING_PATH_MAX_LENGTH,
  REVIEW_LOOP_LIMITS,
  REVIEW_SEVERITIES,
  serializedBytes,
} from "../../../packages/contracts/src/review-evidence.ts";
import { WORKFLOW_ACTION_METADATA } from "../../../packages/contracts/src/workflow-action-registry.ts";
import { FIXED_CODING_PRESET } from "../../../packages/contracts/src/workflow-presets.ts";
import {
  completedWorkerResult,
  enumMembers,
  transportType,
} from "../deterministic-checks/observations.ts";
import {
  failedCheck,
  finding,
  type FindingFixture,
  fingerprintOf,
  inputField,
  JOB_INPUT_STEP_MARGIN_BYTES,
  loopSpec,
  repairInput,
  REVIEW_LOOP_ACTIONS,
  reviewOutput,
  transportInput,
  worstCaseFailedCheck,
  worstCaseFinding,
  worstCaseReviewOutput,
} from "./fixtures.ts";

const sorted = (values: readonly string[]) => [...values].sort();
const sha256Independent = async (text: string): Promise<string> =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Unit cases for the review and repair contracts and their pure helpers. */
export function registerContractCases(): void {
  registerVocabularyCases();
  registerFingerprintCases();
  registerSchemaCases();
  registerBudgetCases();
  registerLoopSpecCases();
  registerRegistryCases();
}

function registerVocabularyCases(): void {
  Deno.test("review vocabularies are closed, frozen lists with exact guards", () => {
    assertEquals([...REVIEW_SEVERITIES], ["blocker", "major", "minor", "note"]);
    assertEquals([...DELIVERY_DECISIONS], ["proceed", "repair", "stop"]);
    assertEquals([...DELIVERY_DECISION_REASONS], [
      "clean",
      "repair_selected",
      "policy_missing",
      "stale_evidence",
      "checks_unavailable",
      "repeated_blocker",
      "repair_cycles_exhausted",
      "repair_time_exhausted",
      "repair_budget_exhausted",
      "reviewer_unavailable",
      "review_failed",
    ]);
    for (
      const list of [
        REVIEW_SEVERITIES,
        DELIVERY_DECISIONS,
        DELIVERY_DECISION_REASONS,
      ] as const
    ) {
      assert(Object.isFrozen(list));
      assertEquals(new Set(list).size, list.length);
    }
    for (const value of REVIEW_SEVERITIES) assert(isReviewSeverity(value));
    for (const value of DELIVERY_DECISIONS) assert(isDeliveryDecision(value));
    for (const value of DELIVERY_DECISION_REASONS) {
      assert(isDeliveryDecisionReason(value));
    }
    for (
      const guard of [
        isReviewSeverity,
        isDeliveryDecision,
        isDeliveryDecisionReason,
      ]
    ) {
      for (const value of ["", "BLOCKER", "stop ", 0, null, undefined, {}]) {
        assertFalse(guard(value), String(value));
      }
    }
  });

  Deno.test("only blocker and major findings block delivery", () => {
    assertEquals(
      REVIEW_SEVERITIES.map((severity) => isBlockingSeverity(severity)),
      [true, true, false, false],
    );
    for (const severity of REVIEW_SEVERITIES) {
      assertEquals(
        finding({ severity }).blocking,
        isBlockingSeverity(severity),
        severity,
      );
    }
  });

  Deno.test("every decision reason explains exactly one decision", () => {
    assertEquals(
      sorted(Object.keys(DELIVERY_REASON_DECISIONS)),
      sorted(DELIVERY_DECISION_REASONS),
    );
    for (const reason of DELIVERY_DECISION_REASONS) {
      const owner = DELIVERY_REASON_DECISIONS[reason];
      for (const decision of DELIVERY_DECISIONS) {
        assertEquals(
          isCoherentDeliveryDecision(decision, reason),
          decision === owner,
          `${decision}/${reason}`,
        );
      }
    }
    assertEquals(DELIVERY_REASON_DECISIONS.clean, "proceed");
    assertEquals(DELIVERY_REASON_DECISIONS.repair_selected, "repair");
    // Everything else ends the run, and none of it can be an approval.
    const stops = DELIVERY_DECISION_REASONS.filter((reason) =>
      reason !== "clean" && reason !== "repair_selected"
    );
    assertEquals(stops.length, 9);
    for (const reason of stops) {
      assertEquals(DELIVERY_REASON_DECISIONS[reason], "stop", reason);
    }
  });

  Deno.test("loop limits are the documented frozen constants", () => {
    assert(Object.isFrozen(REVIEW_LOOP_LIMITS));
    assertEquals({ ...REVIEW_LOOP_LIMITS }, {
      maxRepairCycles: 2,
      maxRepairCyclesCeiling: 8,
      maxLoopDurationMs: 86_400_000,
      maxFindings: 25,
      resultByteBudget: 20_000,
    });
    assert(
      REVIEW_LOOP_LIMITS.maxRepairCycles <=
        REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling,
    );
    assertEquals(DELIVERY_LOOP_STOPPED_CODE, "DELIVERY_LOOP_STOPPED");
    assertEquals(DELIVERY_GATE_STEP_KEY, "delivery_gate");
  });

  Deno.test("transport enums and bounds list exactly the vocabulary constants", () => {
    const enumOf = (type: string) => sorted(enumMembers(type));
    assertEquals(
      enumOf(inputField("Finding", "severity").type),
      sorted(REVIEW_SEVERITIES),
    );
    const reviewFinding = transportType("ReviewFinding").fieldTypes as Record<
      string,
      string
    >;
    assertEquals(enumOf(reviewFinding.severity), sorted(REVIEW_SEVERITIES));
    const decision = transportType("DeliveryDecision").fieldTypes as Record<
      string,
      string
    >;
    assertEquals(enumOf(decision.decision), sorted(DELIVERY_DECISIONS));
    assertEquals(enumOf(decision.reason), sorted(DELIVERY_DECISION_REASONS));
    // A failed check is never a pass: its enums are the check vocabularies
    // without the pass-only members.
    assertEquals(
      enumOf(inputField("FailedCheck", "result").type),
      sorted(CHECK_RESULTS.filter((result) => result !== "passed")),
    );
    assertEquals(
      enumOf(inputField("FailedCheck", "reason").type),
      sorted(CHECK_REASONS.filter((reason) => reason !== "verified")),
    );

    assertEquals(
      inputField("Finding", "path").bounds?.maxLength,
      REVIEW_FINDING_PATH_MAX_LENGTH,
    );
    assertEquals(
      inputField("Finding", "detail").bounds?.maxLength,
      REVIEW_FINDING_DETAIL_MAX_LENGTH,
    );
    assertEquals(
      inputField("RepairInput", "findings").bounds?.maxItems,
      REVIEW_LOOP_LIMITS.maxFindings,
    );
    assertEquals(
      inputField("RepairInput", "failedChecks").bounds?.maxItems,
      REPAIR_FAILED_CHECKS_MAX_ITEMS,
    );
    assertEquals(
      inputField("ReviewInput", "evidence").bounds?.maxItems,
      REVIEW_EVIDENCE_MAX_ITEMS,
    );
    const limits = transportType("DeliveryLoopLimits").fieldBounds as Record<
      string,
      { min: number; max: number }
    >;
    assertEquals(
      limits.maxRepairCycles.max,
      REVIEW_LOOP_LIMITS.maxRepairCyclesCeiling,
    );
    assertEquals(
      limits.maxLoopDurationMs.max,
      REVIEW_LOOP_LIMITS.maxLoopDurationMs,
    );
    assertEquals(limits.maxFindings.max, REVIEW_LOOP_LIMITS.maxFindings);
    for (const name of ["ReviewCycle", "DeliveryDecision"]) {
      const bounds = transportType(name).fieldBounds as Record<
        string,
        { max?: number; maxItems?: number }
      >;
      const cap = bounds.findingCount?.max ?? bounds.blockingFingerprints
        ?.maxItems;
      assertEquals(cap, REVIEW_LOOP_LIMITS.maxFindings, name);
    }
  });
}

function registerFingerprintCases(): void {
  const key = { path: "src/a.ts", category: "logic", title: "Off by one" };

  Deno.test("a fingerprint is the lowercase sha256 of the normalized key", async () => {
    const fingerprint = await findingFingerprint(key);
    assert(/^[0-9a-f]{64}$/.test(fingerprint));
    // Recomputed here from the documented canonical form, not by the helper.
    assertEquals(
      fingerprint,
      await sha256Independent(
        '{"category":"logic","path":"src/a.ts","title":"off by one"}',
      ),
    );
  });

  Deno.test("case, whitespace and line number changes keep the fingerprint", async () => {
    const fingerprint = await findingFingerprint(key);
    for (
      const same of [
        { ...key, path: "SRC/A.TS" },
        { ...key, category: "  LOGIC " },
        { ...key, title: "  Off   by\tone\n" },
        { ...key, path: "src/a.ts:42" },
        { ...key, path: "src/a.ts:42:7" },
        { path: " Src/A.ts:9 ", category: "Logic", title: "OFF BY  ONE" },
      ]
    ) {
      assertEquals(await findingFingerprint(same), fingerprint, same.path);
    }
    assertEquals(
      normalizeFindingKey({
        path: " Src/A.ts:9 ",
        category: "Logic",
        title: "OFF BY  ONE",
      }),
      { path: "src/a.ts", category: "logic", title: "off by one" },
    );
  });

  Deno.test("a different path, category or title is a different finding", async () => {
    const fingerprint = await findingFingerprint(key);
    const seen = new Set([fingerprint]);
    for (
      const other of [
        { ...key, path: "src/b.ts" },
        { ...key, category: "style" },
        { ...key, title: "Off by two" },
        { ...key, title: "Off by one." },
        // The three fields are not interchangeable.
        { path: "logic", category: "src/a.ts", title: "Off by one" },
      ]
    ) {
      const changed = await findingFingerprint(other);
      assertNotEquals(changed, fingerprint, JSON.stringify(other));
      seen.add(changed);
    }
    assertEquals(seen.size, 6);
  });

  Deno.test("serialized bytes count UTF-8 bytes of the canonical form", () => {
    assertEquals(serializedBytes({ a: "xyz" }), 11);
    // Key order never changes the measure; non-ASCII text costs its bytes.
    assertEquals(
      serializedBytes({ b: 1, a: 2 }),
      serializedBytes({ a: 2, b: 1 }),
    );
    assertEquals(serializedBytes("字"), 5);
    assertEquals(serializedBytes(null), 4);
  });
}

function registerSchemaCases(): void {
  Deno.test("review and repair schemas carry meaningful descriptions on every node", () => {
    const schemas = {
      Finding: contractSchemas.Finding,
      FailedCheck: contractSchemas.FailedCheck,
      RepairInput: contractSchemas.RepairInput,
      ReviewInput: contractSchemas.ReviewInput,
      ReviewCycle: contractSchemas.ReviewCycle,
      ReviewFinding: contractSchemas.ReviewFinding,
      DeliveryLoopLimits: contractSchemas.DeliveryLoopLimits,
      DeliveryDecision: contractSchemas.DeliveryDecision,
      "Page<ReviewCycle>": contractSchemas["Page<ReviewCycle>"],
      "Page<DeliveryDecision>": contractSchemas["Page<DeliveryDecision>"],
      "ReviewOutput (review.independent)": workerActionOutputSchema(
        "review.independent",
      ),
    };
    for (const [name, schema] of Object.entries(schemas)) {
      assertEquals(
        descriptionDefectKind(schema.description, name),
        undefined,
        name,
      );
      assertDescribedJsonSchema(toJsonSchema(schema), name);
    }
    for (
      const name of ["Finding", "FailedCheck", "RepairInput", "ReviewInput"]
    ) {
      const definition = transportInput(name);
      assertEquals(
        descriptionDefectKind(definition.description, name),
        undefined,
        name,
      );
      for (const field of definition.fields) {
        assert(
          (field.description ?? "").length >= 30 &&
            !(field.description ?? "").startsWith(field.name),
          `${name}.${field.name} description is not meaningful`,
        );
      }
    }
    for (const name of ["ReviewCycle", "ReviewFinding", "DeliveryDecision"]) {
      const definition = transportType(name);
      const descriptions = definition.fieldDescriptions as Record<
        string,
        string
      >;
      assertEquals(
        sorted(Object.keys(descriptions)),
        sorted(definition.fields as string[]),
        name,
      );
      for (const [field, description] of Object.entries(descriptions)) {
        assert(
          description.length >= 30 && !description.startsWith(field),
          `${name}.${field} description is not meaningful`,
        );
      }
    }
  });

  Deno.test("ReviewOutput carries the reviewer session so admission creates one", () => {
    assert(workerActionOutputCarriesSession("review.independent"));
    assert(workerActionOutputCarriesSession("harness.implement"));
    assertFalse(workerActionOutputCarriesSession("quality.check"));
    const schema = workerActionOutputSchema("review.independent");
    const valid = reviewOutput([
      finding({ severity: "blocker" }),
      finding({
        fingerprint: fingerprintOf(2),
        severity: "note",
        line: null,
      }),
    ]);
    assert(schema.safeParse(valid).success);
    assertEquals(valid.blockingFindings, 1);
    // A clean review has no findings at all.
    assert(schema.safeParse(reviewOutput([])).success);
    const { sessionId: _omitted, ...withoutSession } = valid;
    assertFalse(schema.safeParse(withoutSession).success);
  });

  Deno.test("ReviewOutput rejects approvals, extra text and out-of-range counts", () => {
    const schema = workerActionOutputSchema("review.independent");
    const valid = reviewOutput([finding()]);
    for (
      const forged of [
        { ...valid, approved: true },
        { ...valid, verdict: "approved" },
        { ...valid, stdout: "LGTM" },
        { ...valid, sessionId: "not-a-uuid" },
        { ...valid, reviewId: "not-a-uuid" },
        { ...valid, headSha: "" },
        { ...valid, baseSha: "" },
        { ...valid, policyDigest: "" },
        { ...valid, blockingFindings: -1 },
        { ...valid, blockingFindings: 26 },
        { ...valid, blockingFindings: 1.5 },
        { ...valid, findings: [{ ...finding(), approved: true }] },
        {
          ...valid,
          findings: Array.from(
            { length: REVIEW_LOOP_LIMITS.maxFindings + 1 },
            (_, index) => finding({ fingerprint: fingerprintOf(index + 1) }),
          ),
        },
      ]
    ) {
      assertFalse(
        schema.safeParse(forged).success,
        JSON.stringify(forged).slice(0, 120),
      );
    }
    // The cap itself is accepted.
    assert(
      schema.safeParse(
        reviewOutput(
          Array.from(
            { length: REVIEW_LOOP_LIMITS.maxFindings },
            (_, index) => finding({ fingerprint: fingerprintOf(index + 1) }),
          ),
        ),
      ).success,
    );
  });

  Deno.test("Finding bounds reject malformed fingerprints, paths, lines and text", () => {
    const schema = contractSchemas.Finding;
    assert(schema.safeParse(finding()).success);
    assert(schema.safeParse(finding({ line: null })).success);
    for (
      const forged of [
        { ...finding(), fingerprint: "abc" },
        { ...finding(), fingerprint: "a".repeat(63) },
        { ...finding(), fingerprint: "g".repeat(64) },
        { ...finding(), severity: "critical" },
        { ...finding(), blocking: "yes" },
        { ...finding(), path: "" },
        { ...finding(), path: "x".repeat(REVIEW_FINDING_PATH_MAX_LENGTH + 1) },
        { ...finding(), line: 0 },
        { ...finding(), line: -3 },
        { ...finding(), line: 1.5 },
        { ...finding(), detail: "" },
        {
          ...finding(),
          detail: "x".repeat(REVIEW_FINDING_DETAIL_MAX_LENGTH + 1),
        },
        { ...finding(), extra: true },
      ]
    ) {
      assertFalse(
        schema.safeParse(forged).success,
        JSON.stringify(forged).slice(0, 120),
      );
    }
    const { line: _omitted, ...withoutLine } = finding();
    assertFalse(schema.safeParse(withoutLine).success);
  });

  Deno.test("RepairInput and ReviewInput bind an exact revision and bounded lists", () => {
    const repair = contractSchemas.RepairInput;
    const failed = failedCheck();
    assert(repair.safeParse(repairInput({ failedChecks: [failed] })).success);
    assert(
      repair.safeParse(repairInput({ findings: [], failedChecks: [failed] }))
        .success,
    );
    // The "at least one finding or failed check" rule is a runtime rule of the
    // worker and the controller, so the wire schema still accepts both empty.
    assert(repair.safeParse(repairInput({ findings: [] })).success);
    for (
      const forged of [
        repairInput({}, { revision: "a".repeat(39) }),
        repairInput({}, { revision: "a".repeat(41) }),
        repairInput({}, { revision: "main" }),
        repairInput({}, { repositoryId: "not-a-uuid" }),
        repairInput({
          findings: Array.from(
            { length: REVIEW_LOOP_LIMITS.maxFindings + 1 },
            (_, index) => finding({ fingerprint: fingerprintOf(index + 1) }),
          ),
        }),
        repairInput({
          failedChecks: Array.from(
            { length: REPAIR_FAILED_CHECKS_MAX_ITEMS + 1 },
            () => failedCheck(),
          ),
        }),
        repairInput({
          failedChecks: [failedCheck({ result: "passed" as never })],
        }),
        repairInput({
          failedChecks: [failedCheck({ reason: "verified" as never })],
        }),
        repairInput({ failedChecks: [failedCheck({ exitCode: 256 })] }),
        repairInput({ failedChecks: [failedCheck({ checkId: "" })] }),
        { ...repairInput(), currentCandidate: {} },
        { ...repairInput(), failedCheckIds: [] },
      ]
    ) {
      assertFalse(
        repair.safeParse(forged).success,
        JSON.stringify(forged).slice(0, 120),
      );
    }
    const { failedChecks: _omitted, ...withoutFailed } = repairInput();
    assertFalse(repair.safeParse(withoutFailed).success);

    const review = contractSchemas.ReviewInput;
    const reviewInput = {
      repositoryId: crypto.randomUUID(),
      revision: "a".repeat(40),
      evidence: [crypto.randomUUID()],
    };
    assert(review.safeParse(reviewInput).success);
    assert(
      registeredWorkerActionInputSchema("review.independent").safeParse(
        reviewInput,
      ).success,
    );
    for (
      const forged of [
        { ...reviewInput, evidence: [] },
        {
          ...reviewInput,
          evidence: Array.from(
            { length: REVIEW_EVIDENCE_MAX_ITEMS + 1 },
            () => crypto.randomUUID(),
          ),
        },
        { ...reviewInput, evidence: ["not-a-uuid"] },
        { ...reviewInput, revision: "main" },
        { ...reviewInput, approved: true },
      ]
    ) {
      assertFalse(
        review.safeParse(forged).success,
        JSON.stringify(forged).slice(0, 120),
      );
    }
  });
}

function registerBudgetCases(): void {
  const fixedIds = {
    reviewId: "00000000-0000-4000-8000-000000000001",
    sessionId: "00000000-0000-4000-8000-000000000002",
  };
  const reviewFits = (candidate: readonly FindingFixture[]) =>
    serializedBytes(reviewOutput(candidate, fixedIds)) <=
      REVIEW_LOOP_LIMITS.resultByteBudget;
  const schema = () => workerActionOutputSchema("review.independent");

  Deno.test("a worst-case review exceeds the byte budget, which is why the server enforces bytes", () => {
    const ascii = worstCaseReviewOutput("x");
    assertEquals(ascii.findings.length, REVIEW_LOOP_LIMITS.maxFindings);
    assert(schema().safeParse(ascii).success);
    const asciiBytes = serializedBytes(ascii);
    // The bounds are characters, so the field maxima alone do not keep a
    // report inside the budget; the 32,000-byte result cap still holds.
    assert(asciiBytes > REVIEW_LOOP_LIMITS.resultByteBudget, `${asciiBytes}`);
    assert(asciiBytes <= 32_000, `${asciiBytes}`);
    assert(
      contractSchemas.WorkerResult.safeParse(completedWorkerResult(ascii))
        .success,
    );
    // Multi-byte text passes the character bounds and overflows the result
    // cap itself, so the byte budget is the only thing that bounds it.
    const cjk = worstCaseReviewOutput("字");
    assert(schema().safeParse(cjk).success);
    assert(serializedBytes(cjk) > 32_000, `${serializedBytes(cjk)}`);
    assertFalse(
      contractSchemas.WorkerResult.safeParse(completedWorkerResult(cjk))
        .success,
    );
  });

  Deno.test("the budget rule trims a worst-case report without dropping a blocker", () => {
    for (const unit of ["x", "字"]) {
      // Ten blockers and majors, fifteen advisory findings, all at maxima.
      const input = Array.from({ length: 25 }, (_, index) =>
        worstCaseFinding(
          index,
          unit,
          (["blocker", "major", "minor", "note"] as const)[
            index < 5 ? 0 : index < 10 ? 1 : index < 18 ? 2 : 3
          ],
        ));
      const fitted = fitFindingsToBudget(input, reviewFits);
      assert(fitted !== null, unit);
      assert(reviewFits(fitted), `${unit}: ${serializedBytes(fitted)}`);
      assertEquals(
        fitted.filter(({ blocking }) => blocking).map((item) =>
          item.fingerprint
        ),
        input.slice(0, 10).map((item) => item.fingerprint),
        unit,
      );
      const report = reviewOutput(fitted, fixedIds);
      assertEquals(report.blockingFindings, 10);
      // The trimmed report still validates and still fits the result cap.
      assert(schema().safeParse(report).success, unit);
      assert(
        contractSchemas.WorkerResult.safeParse(completedWorkerResult(report))
          .success,
        unit,
      );
      for (const item of fitted) {
        assert(item.detail.length >= 1, unit);
        assertEquals(item.blocking, isBlockingSeverity(item.severity));
      }
    }
  });

  Deno.test("the budget rule orders blocker first, keeps an in-budget report intact and refuses to hide a blocker", () => {
    const mixed = [
      finding({ fingerprint: fingerprintOf(1), severity: "note" }),
      finding({ fingerprint: fingerprintOf(2), severity: "major" }),
      finding({ fingerprint: fingerprintOf(3), severity: "blocker" }),
      finding({ fingerprint: fingerprintOf(4), severity: "minor" }),
      finding({ fingerprint: fingerprintOf(5), severity: "blocker" }),
    ];
    const ordered = fitFindingsToBudget(mixed, reviewFits);
    assert(ordered !== null);
    assertEquals(
      ordered.map(({ severity }) => severity),
      ["blocker", "blocker", "major", "minor", "note"],
    );
    // Equal severities keep the reviewer's order.
    assertEquals(
      ordered.map(({ fingerprint }) => fingerprint),
      [3, 5, 2, 4, 1].map(fingerprintOf),
    );
    // Twenty-five multi-byte blockers cannot fit even with shortened details:
    // the rule returns null so the worker faults instead of dropping one.
    const blockers = Array.from(
      { length: REVIEW_LOOP_LIMITS.maxFindings },
      (_, index) => worstCaseFinding(index, "字", "blocker"),
    );
    assertEquals(fitFindingsToBudget(blockers, reviewFits), null);
    // The same blockers fit once they are few enough.
    const some = fitFindingsToBudget(blockers.slice(0, 10), reviewFits);
    assert(some !== null);
    assertEquals(some.length, 10);
  });

  Deno.test("the worst-case RepairInput fits the job input margin by construction", () => {
    const worstFailed = Array.from(
      { length: REPAIR_FAILED_CHECKS_MAX_ITEMS },
      () => worstCaseFailedCheck(),
    );
    const repair = contractSchemas.RepairInput;
    const failedBytes = serializedBytes(worstFailed);
    const envelope = serializedBytes(
      repairInput({ findings: [], failedChecks: [] }),
    );

    // Field maxima at ASCII: 25 findings plus 32 failed checks.
    const asciiFindings = Array.from(
      { length: REVIEW_LOOP_LIMITS.maxFindings },
      (_, index) => worstCaseFinding(index, "x"),
    );
    const ascii = repairInput({
      findings: asciiFindings,
      failedChecks: worstFailed,
    });
    assert(repair.safeParse(ascii).success);
    const asciiBytes = serializedBytes(ascii);
    assert(
      asciiBytes < JOB_INPUT_STEP_MARGIN_BYTES,
      `ASCII worst case is ${asciiBytes} bytes`,
    );

    // The same fields in multi-byte text are not bounded by construction.
    const cjkFindings = Array.from(
      { length: REVIEW_LOOP_LIMITS.maxFindings },
      (_, index) => worstCaseFinding(index, "字"),
    );
    const cjk = repairInput({
      findings: cjkFindings,
      failedChecks: worstFailed,
    });
    assert(repair.safeParse(cjk).success);
    assert(serializedBytes(cjk) > JOB_INPUT_STEP_MARGIN_BYTES);

    // What bounds it is the review budget: the blocking findings of one
    // accepted review are at most `resultByteBudget` bytes, so the repair
    // input stays under the margin even in multi-byte text.
    assert(
      REVIEW_LOOP_LIMITS.resultByteBudget + failedBytes + envelope <
        JOB_INPUT_STEP_MARGIN_BYTES,
      `${REVIEW_LOOP_LIMITS.resultByteBudget} + ${failedBytes} + ${envelope}`,
    );
    for (const unit of ["x", "字"]) {
      const blocking = Array.from(
        { length: REVIEW_LOOP_LIMITS.maxFindings },
        (_, index) => worstCaseFinding(index, unit, "major"),
      ).slice(0, 10);
      const fitted = fitFindingsToBudget(blocking, reviewFits);
      assert(fitted !== null, unit);
      const input = repairInput({
        findings: fitted.filter(({ blocking }) => blocking),
        failedChecks: worstFailed,
      });
      assert(repair.safeParse(input).success, unit);
      assert(
        serializedBytes(input) < JOB_INPUT_STEP_MARGIN_BYTES,
        `${unit}: ${serializedBytes(input)}`,
      );
    }
  });

  Deno.test("fixed command ids are ASCII, so a failed check id never inflates in UTF-8", () => {
    const draft = {
      schemaVersion: 1 as const,
      commands: [{ id: "测试", argv: ["pnpm", "test"] }],
      allowedEffects: ["evidence_only" as const],
      lockedConfiguration: { branches: true, worktree: true, checker: true },
      decisions: [{ commandId: "测试", mode: "require" as const }],
    };
    assertFalse(RepositoryFixedPolicyDraftSchema.safeParse(draft).success);
    const ascii = {
      ...draft,
      commands: [{ id: "unit", argv: ["pnpm", "test"] }],
      decisions: [{ commandId: "unit", mode: "require" as const }],
    };
    assert(RepositoryFixedPolicyDraftSchema.safeParse(ascii).success);
  });
}

function registerLoopSpecCases(): void {
  Deno.test("the reviewed preset shape is a review loop and the fixed coding shape is not", () => {
    assert(isReviewLoopSpec(loopSpec(REVIEW_LOOP_ACTIONS)));
    assertFalse(isReviewLoopSpec(FIXED_CODING_PRESET.spec));
    // Other steps may precede the loop and sit inside it.
    assert(
      isReviewLoopSpec(
        loopSpec([
          "task.brief",
          "harness.implement",
          "agent.freeform",
          "harness.repair",
          "workflow.noop",
          "quality.check",
          "review.independent",
        ]),
      ),
    );
    // A repair iteration is appended after every step, so nothing may follow
    // the review: that step would run on the unrepaired candidate.
    assertFalse(
      isReviewLoopSpec(
        loopSpec([
          "task.brief",
          "harness.implement",
          "harness.repair",
          "quality.check",
          "review.independent",
          "workflow.noop",
        ]),
      ),
    );
  });

  Deno.test("a spec needs exactly one repair, check and review in that order", () => {
    const [brief, implement, repair, check, review] = REVIEW_LOOP_ACTIONS;
    const rejected: Record<string, string[]> = {
      "no repair": [brief, implement, check, review],
      "no check": [brief, implement, repair, review],
      "no review": [brief, implement, repair, check],
      "two repairs": [brief, implement, repair, repair, check, review],
      "two checks": [brief, implement, repair, check, check, review],
      "two reviews": [brief, implement, repair, check, review, review],
      "check before repair": [brief, implement, check, repair, review],
      "review before check": [brief, implement, repair, review, check],
      "review before repair": [brief, implement, review, repair, check],
      "review first": [brief, implement, review, check, repair],
      "no revision-producing step": [brief, repair, check, review],
      "revision-producing step after repair": [
        brief,
        repair,
        implement,
        check,
        review,
      ],
      "only an artifact step before repair": [
        brief,
        "agent.freeform",
        repair,
        check,
        review,
      ],
    };
    for (const [name, actions] of Object.entries(rejected)) {
      assertFalse(isReviewLoopSpec(loopSpec(actions)), name);
    }
  });

  Deno.test("a conditional loop step is not a review loop", () => {
    const [brief, implement, repair, check, review] = REVIEW_LOOP_ACTIONS;
    for (const conditional of [repair, check, review]) {
      const steps = [brief, implement, repair, check, review].map((uses) =>
        uses === conditional ? { uses, if: "$input.run" } : uses
      );
      assertFalse(isReviewLoopSpec(loopSpec(steps)), conditional);
    }
    // A condition elsewhere does not matter.
    assert(
      isReviewLoopSpec(loopSpec([
        brief,
        { uses: implement, if: "$input.run" },
        repair,
        check,
        review,
      ])),
    );
  });

  Deno.test("malformed specs are never a review loop", () => {
    for (
      const spec of [
        undefined,
        null,
        "fixed",
        7,
        [],
        {},
        { steps: {} },
        { steps: "steps" },
        { steps: [null] },
        { steps: [[]] },
        { steps: [{}] },
        { steps: [{ uses: 1 }] },
        {
          steps: [
            ...loopSpec(REVIEW_LOOP_ACTIONS).steps,
            { id: "x" },
          ],
        },
      ]
    ) {
      assertFalse(isReviewLoopSpec(spec), JSON.stringify(spec));
    }
  });
}

function registerRegistryCases(): void {
  Deno.test("review.independent is a registered worker action with the model and reviewer capabilities", () => {
    const published = WORKFLOW_ACTION_METADATA["review.independent"];
    assertEquals([...published.capabilities], ["model", "reviewer"]);
    // workerActionCapabilities asserts the generated contract equals the
    // published action metadata, so this also pins the schema names.
    assertEquals(workerActionCapabilities("review.independent"), [
      "model",
      "reviewer",
    ]);
    assert(workerActionCapabilityNames.includes("reviewer"));
    assert(
      (workflowRuntimeImplementedActions as readonly string[]).includes(
        "review.independent",
      ),
    );
    assertEquals(published.input, "ReviewInput");
    assertEquals(published.output, "ReviewOutput");
    assertEquals(published.effectPolicy, "review_evidence");
  });

  Deno.test("review.independent maps to the review_evidence effect and profiles may allow five effects", () => {
    assertEquals(
      REPOSITORY_FIXED_POLICY_ACTION_EFFECTS["review.independent"],
      "review_evidence",
    );
    assertEquals(
      REPOSITORY_FIXED_POLICY_ACTION_EFFECTS["review.independent"],
      WORKFLOW_ACTION_METADATA["review.independent"].effectPolicy,
    );
    assert(RepositoryPolicyEffectSchema.safeParse("review_evidence").success);
    assertFalse(RepositoryPolicyEffectSchema.safeParse("review").success);
    const policy = (allowedEffects: readonly string[]) => ({
      schemaVersion: 1,
      commands: [{ id: "unit", argv: ["pnpm", "test"] }],
      allowedEffects,
      lockedConfiguration: { branches: true, worktree: true, checker: true },
      decisions: [{ commandId: "unit", mode: "require" }],
    });
    const all = [
      "artifact_only",
      "repository_revision",
      "evidence_only",
      "review_evidence",
      "projection_only",
    ];
    assert(RepositoryFixedPolicyDraftSchema.safeParse(policy(all)).success);
    assert(
      RepositoryFixedPolicyDraftSchema.safeParse(
        policy(all.slice(0, 4)),
      ).success,
    );
    // Six entries exceed the cap, and a repeated effect is never legal.
    assertFalse(
      RepositoryFixedPolicyDraftSchema.safeParse(
        policy([...all, "artifact_only"]),
      ).success,
    );
    assertFalse(
      RepositoryFixedPolicyDraftSchema.safeParse(
        policy(["review_evidence", "review_evidence"]),
      ).success,
    );
  });

  Deno.test("the catalog lists the run-scoped review operations beside the pull request one", () => {
    const byName = new Map(
      catalogActions.map((action) => [action.action, action]),
    );
    const expected = {
      "runReviews.list": ["/v1/runs/{id}/reviews", "Page<ReviewCycle>"],
      "runDeliveryDecisions.list": [
        "/v1/runs/{id}/delivery-decisions",
        "Page<DeliveryDecision>",
      ],
    } as const;
    for (const [name, [path, output]] of Object.entries(expected)) {
      const entry = byName.get(name as never);
      assert(entry, name);
      assertEquals(entry.method, "GET", name);
      assertEquals(entry.path, path, name);
      assertEquals(entry.output, output, name);
      assertEquals(entry.input, "CursorQuery", name);
      assertEquals(entry.permission, "review:read", name);
      assertEquals(entry.access, "Developer", name);
      assertEquals(
        entry.organizationContext,
        "required_authenticated_context",
        name,
      );
      assert(entry.errors.includes("SCOPE_REQUIRED"), name);
    }
    const findings = byName.get("reviewFindings.list");
    assert(findings);
    assertEquals(findings.path, "/v1/reviews/{id}/findings");
    assertEquals(
      findings.organizationContext,
      "required_authenticated_context",
    );
    assert(findings.errors.includes("SCOPE_REQUIRED"));
    // The pull-request-scoped operation keeps its shape until pull requests
    // have a table.
    const pullRequestReviews = byName.get("reviews.list");
    assert(pullRequestReviews);
    assertEquals(pullRequestReviews.path, "/v1/pull-requests/{id}/reviews");
    assertEquals(pullRequestReviews.output, "Page<ReviewCycle>");
  });
}
