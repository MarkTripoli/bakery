import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import {
  DECISION_LEDGER_KINDS,
  decisionKindRequiresReason,
  DecisionLedgerError,
  DEFAULT_STOP_OUTCOME,
  HUMAN_APPROVAL_WAIT_LIMIT_MS,
  humanApprovalContinues,
  HumanApprovalInputSchema,
  isStorableDecisionText,
  normalizeWorkflowStop,
  validateDecisionLedgerEntry,
  WorkflowStopInputSchema,
} from "../../packages/contracts/src/human-approval.ts";
import { createWorkflowActionRuntime } from "../../apps/server/src/modules/workflows/action-runtime.ts";

// #411, slice 9 of the one-engine design: human.approval, the decisions ledger,
// waits up to seven days outside the active clock, named outcomes and
// workflow.stop.

const decided = "00000000-0000-4000-8000-0000000000d1";
const subject = "00000000-0000-4000-8000-0000000000s1";

Deno.test("only an approval lets a human.approval step continue", () => {
  assert(humanApprovalContinues("approve"));
  // The other two end the run with their own named outcome; neither proceeds.
  assertEquals(humanApprovalContinues("request_changes"), false);
  assertEquals(humanApprovalContinues("reject"), false);
});

Deno.test("a human.approval step needs a prompt and may name its audience", () => {
  const minimal = HumanApprovalInputSchema.safeParse({ prompt: "Ship it?" });
  assert(minimal.success);
  // No audience means the workflow owner, which is the design's default.
  assertEquals(minimal.data.audience, undefined);

  const withAudience = HumanApprovalInputSchema.safeParse({
    prompt: "Ship it?",
    audience: ["@design-reviewers", "member:sam"],
    allowRequestChanges: false,
    approveLabel: "Release",
  });
  assert(withAudience.success);
  assertEquals(withAudience.data.allowRequestChanges, false);
});

Deno.test("a human.approval step with no prompt, or an empty audience, is refused", () => {
  assertEquals(
    HumanApprovalInputSchema.safeParse({ prompt: "" }).success,
    false,
  );
  assertEquals(
    HumanApprovalInputSchema.safeParse({ prompt: "Ok?" }).success,
    true,
  );
  // An empty audience would be a step nobody can answer: it could only expire.
  assertEquals(
    HumanApprovalInputSchema.safeParse({ prompt: "Ok?", audience: [] }).success,
    false,
  );
  // Unknown keys are refused rather than silently dropped.
  assertEquals(
    HumanApprovalInputSchema.safeParse({ prompt: "Ok?", aprroveLabel: "x" })
      .success,
    false,
  );
});

Deno.test("the approval ceiling is one seven-day constant, not a restatement", () => {
  assertEquals(HUMAN_APPROVAL_WAIT_LIMIT_MS, 7 * 24 * 60 * 60 * 1000);
});

Deno.test("workflow.stop names its outcome and defaults it when unnamed", () => {
  const named = WorkflowStopInputSchema.safeParse({
    outcome: "nothing_to_do",
    reason: "the ticket was already fixed upstream",
  });
  assert(named.success);
  assertEquals(normalizeWorkflowStop(named.data).outcome, "nothing_to_do");

  // A stop still ends the run when it names nothing: the reason often explains
  // the ending better than a name would. This goes through the schema first, the
  // way production does, so the test pins the reachable path rather than an
  // empty string the schema now refuses.
  const unnamed = WorkflowStopInputSchema.safeParse({
    reason: "nothing to do",
  });
  assert(unnamed.success);
  assertEquals(unnamed.data.outcome, undefined);
  assertEquals(
    normalizeWorkflowStop(unnamed.data).outcome,
    DEFAULT_STOP_OUTCOME,
  );
  assertEquals(normalizeWorkflowStop(unnamed.data).reason, "nothing to do");
  // Absent, not null: the output field is optional and the docs say "absent
  // when the caller gave none".
  assertEquals("reason" in normalizeWorkflowStop({}), false);

  // An explicitly empty outcome is still refused: omit it, do not blank it.
  assertFalse(WorkflowStopInputSchema.safeParse({ outcome: "" }).success);

  // An unknown key is refused rather than ignored.
  assertEquals(
    WorkflowStopInputSchema.safeParse({ outcome: "x", cause: "y" }).success,
    false,
  );
});

Deno.test("the production stop handler applies the default, not just the helper", () => {
  // The whole point of the optional outcome is that a caller can omit it and
  // still get `DEFAULT_STOP_OUTCOME`. This runs the handler the server actually
  // calls, so the default branch is proven reachable in production instead of
  // only in `normalizeWorkflowStop` tests that never crossed the validator.
  const { handle } = createWorkflowActionRuntime().get("workflow.stop").handler;

  const unnamed = handle({ reason: "the ticket was already fixed upstream" });
  assertEquals(unnamed, {
    outcome: DEFAULT_STOP_OUTCOME,
    reason: "the ticket was already fixed upstream",
  });

  const named = handle({ outcome: "nothing_to_do" });
  assertEquals(named, { outcome: "nothing_to_do" });

  // A stop with neither still ends the run, and leaves reason absent rather
  // than null: the output schema types it as an optional string.
  assertEquals(handle({}), { outcome: DEFAULT_STOP_OUTCOME });

  // And a blank name is refused before the helper ever sees it.
  assertThrows(() => handle({ outcome: "" }));
});

Deno.test("only accept_with_reason and stop must give a reason", () => {
  for (const kind of DECISION_LEDGER_KINDS) {
    const required = decisionKindRequiresReason(kind);
    if (kind === "accept_with_reason" || kind === "stop") {
      assert(required, `${kind} must require a reason`);
    } else {
      assertEquals(required, false, `${kind} must not require a reason`);
    }
  }
});

Deno.test("a ledger entry records what, about what, by whom", () => {
  const entry = validateDecisionLedgerEntry({
    kind: "approval",
    subjectKind: "approval",
    subjectId: subject,
    decidedBy: decided,
    decidedAt: "2026-11-01T00:00:00.000Z",
  });
  assertEquals(entry.kind, "approval");
  assertEquals(entry.subjectId, subject);
});

Deno.test("an override or a stop without a reason is refused", () => {
  for (const kind of ["accept_with_reason", "stop"] as const) {
    assertThrows(
      () =>
        validateDecisionLedgerEntry({
          kind,
          subjectKind: "run",
          subjectId: subject,
          decidedBy: decided,
          decidedAt: "2026-11-01T00:00:00.000Z",
        }),
      DecisionLedgerError,
      undefined,
      `${kind} without a reason must be refused`,
    );
    // Whitespace is not a reason.
    assertThrows(() =>
      validateDecisionLedgerEntry({
        kind,
        subjectKind: "run",
        subjectId: subject,
        decidedBy: decided,
        decidedAt: "2026-11-01T00:00:00.000Z",
        reason: "   ",
      })
    );
    // A real reason is accepted.
    assertEquals(
      validateDecisionLedgerEntry({
        kind,
        subjectKind: "run",
        subjectId: subject,
        decidedBy: decided,
        decidedAt: "2026-11-01T00:00:00.000Z",
        reason: "the reviewer is right and the owner accepts the risk",
      }).kind,
      kind,
    );
  }
});

Deno.test("a ledger entry refuses text it cannot store", () => {
  assertEquals(isStorableDecisionText("plain note"), true);
  assertEquals(isStorableDecisionText("nul\u0000inside"), false);
  assertEquals(isStorableDecisionText("lone\ud800surrogate"), false);

  assertThrows(() =>
    validateDecisionLedgerEntry({
      kind: "stop",
      subjectKind: "run",
      subjectId: subject,
      decidedBy: decided,
      decidedAt: "2026-11-01T00:00:00.000Z",
      reason: "bad\u0000reason",
    })
  );
});

Deno.test("a ledger entry is strict about its shape", () => {
  // subjectKind is bounded free text because the subjects grow with the
  // extension points; subjectId must be a real identifier.
  assertEquals(
    validateDecisionLedgerEntry({
      kind: "steer",
      subjectKind: "session",
      subjectId: subject,
      decidedBy: decided,
      decidedAt: "2026-11-01T00:00:00.000Z",
      text: "try the other approach",
    }).text,
    "try the other approach",
  );
});
