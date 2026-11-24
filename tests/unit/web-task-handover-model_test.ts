import { assertEquals } from "@std/assert";
import {
  carryOn,
  FRESH_REASONS,
  outcomeKey,
  outcomeUnknown,
  reasonKey,
  recordedHandover,
  refusalOf,
  viewManifest,
} from "../../apps/web/src/pages/task-handover/model.ts";

const UUID = "00000000-0000-4000-8000-000000000001";
const SHA = "a".repeat(40);

function manifest(over: Record<string, unknown> = {}) {
  return {
    goal: "Fix the flaky retry test",
    nextAction: "Run the suite again",
    decisions: ["Keep the public API", "No new dependency"],
    repository: {
      commitSha: SHA,
      uncommittedPatch: null,
      captureStatus: "complete",
    },
    context: { artifactRefs: [{ artifactId: UUID, versionId: UUID }] },
    tests: [{
      command: "pnpm test",
      result: "failed",
      evidenceVersionId: null,
    }],
    pendingEffects: [],
    ...over,
  };
}

Deno.test("a stored manifest is shown as the goal, the next action, decisions, documents, code, checks and outside actions", () => {
  const view = viewManifest(manifest())!;
  assertEquals(view.goal, "Fix the flaky retry test");
  assertEquals(view.nextAction, "Run the suite again");
  assertEquals(view.decisions.length, 2);
  assertEquals(view.documents, [{ artifactId: UUID, versionId: UUID }]);
  assertEquals(view.commitShort, "aaaaaaaa");
  assertEquals(view.hasPatch, false);
  assertEquals(view.capturePaused, false);
  assertEquals(view.checks[0]!.result, "failed");
  assertEquals(view.unconfirmedEffects, 0);
});

Deno.test("only outside actions not yet confirmed or failed are counted as unconfirmed", () => {
  const view = viewManifest(manifest({
    pendingEffects: [
      { effectId: UUID, state: "uncertain" },
      { effectId: UUID, state: "prepared" },
      { effectId: UUID, state: "confirmed" },
      { effectId: UUID, state: "failed" },
    ],
  }))!;
  assertEquals(view.unconfirmedEffects, 2);
});

Deno.test("a patch and a paused capture are read from the repository", () => {
  const view = viewManifest(manifest({
    repository: {
      commitSha: SHA,
      uncommittedPatch: { artifactId: UUID },
      captureStatus: "paused",
    },
  }))!;
  assertEquals([view.hasPatch, view.capturePaused], [true, true]);
});

Deno.test("a manifest that is not in the shape the server stored is not shown, never guessed at", () => {
  for (
    const bad of [
      null,
      "text",
      [],
      {},
      manifest({ goal: "" }),
      manifest({ nextAction: undefined }),
      manifest({ decisions: "x" }),
      manifest({ repository: {} }),
      manifest({ context: { artifactRefs: [{ artifactId: UUID }] } }),
      manifest({ tests: [{ result: "passed" }] }),
      manifest({ pendingEffects: [7] }),
    ]
  ) assertEquals(viewManifest(bad), null, JSON.stringify(bad)?.slice(0, 60));
  assertEquals(
    viewManifest(manifest({
      tests: [{ command: "x", result: "great", evidenceVersionId: null }],
    }))!.checks[0]!.result,
    "unknown",
  );
});

Deno.test("an exact pick-up is promised only when the server says exact, the point is safe and no outside action waits", () => {
  const view = viewManifest(manifest())!;
  const exact = {
    decisionMode: "exact_harness_resume" as const,
    freshReason: null,
    safeBoundary: true,
  };
  assertEquals(carryOn(exact, view), { kind: "exact" });
  assertEquals(carryOn({ ...exact, safeBoundary: false }, view).kind, "fresh");
  const waiting = viewManifest(manifest({
    pendingEffects: [{ effectId: UUID, state: "submitted" }],
  }))!;
  assertEquals(carryOn(exact, waiting).kind, "fresh");
  assertEquals(
    carryOn({
      decisionMode: "fresh_session",
      freshReason: "native_evidence_mismatch",
      safeBoundary: true,
    }, view),
    { kind: "fresh", reason: "native_evidence_mismatch" },
  );
  assertEquals(
    carryOn({
      decisionMode: "fresh_session",
      freshReason: null,
      safeBoundary: true,
    }, view),
    { kind: "fresh", reason: "unknown" },
  );
});

Deno.test("every reason the server can give has its own sentence key", () => {
  assertEquals(FRESH_REASONS.length, 8);
  for (const reason of FRESH_REASONS) {
    assertEquals(reasonKey(reason), `tasks.run.handover.reason.${reason}`);
  }
  assertEquals(reasonKey("unknown"), "tasks.run.handover.reason.unknown");
});

Deno.test("the line after a hand-over says exact, fresh, or that the step waits for an outside action", () => {
  assertEquals(
    outcomeKey({ mode: "exact_harness_resume", freshReason: null }, 0),
    "exact",
  );
  assertEquals(
    outcomeKey({ mode: "fresh_session", freshReason: "boundary_unsafe" }, 0),
    "fresh",
  );
  assertEquals(
    outcomeKey({ mode: "fresh_session", freshReason: "effects_unresolved" }, 1),
    "waiting",
  );
  assertEquals(
    outcomeKey({ mode: "fresh_session", freshReason: "fresh_requested" }, 0),
    "freshChosen",
  );
  assertEquals(
    outcomeKey({ mode: "fresh_session", freshReason: "fresh_requested" }, 2),
    "waiting",
  );
});

Deno.test("each refusal reads as designed: the card stays or closes, and the run is read again when it moved", () => {
  const conflict = (reason: string) =>
    refusalOf({ kind: "problem", problem: { code: "STATE_CONFLICT", reason } });
  assertEquals(
    refusalOf({ kind: "problem", problem: { code: "PRECONDITION_FAILED" } }),
    { key: "tasks.run.handover.refused.changed", where: "card", reload: true },
  );
  for (const reason of ["already_continued", "fence_moved"]) {
    assertEquals(conflict(reason).key, "tasks.run.handover.refused.already");
    assertEquals(conflict(reason).where, "page");
  }
  assertEquals(
    conflict("source_not_live").key,
    "tasks.run.handover.refused.sourceStopped",
  );
  for (const reason of ["run_not_active", "job_terminal", "cancel_requested"]) {
    assertEquals(conflict(reason).key, "tasks.run.handover.refused.notRunning");
  }
  assertEquals(
    conflict("manifest_blocked").key,
    "tasks.run.handover.refused.blocked",
  );
  assertEquals(
    conflict("awaiting_reconciliation").key,
    "tasks.run.handover.refused.reconciling",
  );
  assertEquals(
    conflict("attempt_budget_exhausted").key,
    "tasks.run.handover.refused.budget",
  );
  assertEquals(conflict("capture_incomplete").where, "card");
  for (
    const other of [
      conflict("something_new"),
      refusalOf({ kind: "problem", problem: { code: "STATE_CONFLICT" } }),
      refusalOf({ kind: "network" }),
    ]
  ) {
    assertEquals(other.key, "tasks.run.handover.refused.other");
    assertEquals(other.where, "card");
  }
});

Deno.test("a lost answer may have gone through, so the same key is sent again; a definite answer ends the key", () => {
  assertEquals(outcomeUnknown({ kind: "network" }), true);
  assertEquals(
    outcomeUnknown({
      kind: "problem",
      problem: { status: 503, retryable: true },
    }),
    true,
  );
  assertEquals(
    outcomeUnknown({
      kind: "problem",
      problem: { status: 409, retryable: false },
    }),
    false,
  );
});

Deno.test("a hand-over already made reads from what the server recorded, the same for every reader", () => {
  const recorded = (over: Record<string, unknown> = {}) => ({
    status: "continued" as const,
    manifest: manifest(),
    continuedMode: "exact_harness_resume" as const,
    continuedFreshReason: null,
    continuedByName: "Ana Silva",
    continuedAt: "2026-01-01T00:05:00.000Z",
    ...over,
  });
  const exact = recordedHandover(recorded())!;
  assertEquals(
    [exact.outcome, exact.byName, exact.at],
    ["exact", "Ana Silva", "2026-01-01T00:05:00.000Z"],
  );
  const fresh = recordedHandover(recorded({
    continuedMode: "fresh_session",
    continuedFreshReason: "boundary_unsafe",
  }))!;
  assertEquals([fresh.outcome, fresh.reason], ["fresh", "boundary_unsafe"]);
  const waiting = recordedHandover(recorded({
    continuedMode: "fresh_session",
    continuedFreshReason: "effects_unresolved",
    manifest: manifest({
      pendingEffects: [{ effectId: UUID, state: "uncertain" }],
    }),
  }))!;
  assertEquals([waiting.outcome, waiting.unconfirmedEffects], ["waiting", 1]);
  assertEquals(
    recordedHandover(recorded({ continuedByName: null }))!.byName,
    null,
  );
  assertEquals(recordedHandover(recorded({ status: "pending" })), null);
  assertEquals(recordedHandover(recorded({ continuedAt: null })), null);
  assertEquals(recordedHandover(recorded({ continuedMode: null })), null);
});
