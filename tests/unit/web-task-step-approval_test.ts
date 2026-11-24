import { assertEquals } from "@std/assert";
import {
  approvalStep,
  capitalized,
  decisionOf,
  latestStepApproval,
  openStepApproval,
  refusalOf,
  runOutcome,
  stepName,
} from "../../apps/web/src/pages/task-step-approval/model.ts";

const RUN = "00000000-0000-4000-8000-000000000001";

function approval(over: Record<string, unknown>) {
  return {
    id: "a1",
    subjectType: "run_step",
    status: "open",
    subjectId: RUN,
    createdAt: "2026-11-24T10:00:00.000Z",
    ...over,
  } as never;
}

Deno.test("only an open run_step approval of this run is offered, newest first", () => {
  const list = [
    approval({ id: "old", createdAt: "2026-11-24T09:00:00.000Z" }),
    approval({ id: "new" }),
    approval({ id: "decided", status: "answered" }),
    approval({ id: "plan", subjectType: "plan_revision" }),
    approval({
      id: "other",
      subjectId: "00000000-0000-4000-8000-000000000002",
    }),
  ];
  assertEquals(openStepApproval(list, RUN)?.id, "new");
  assertEquals(openStepApproval([], RUN), null);
  assertEquals(openStepApproval(list.slice(2), RUN), null);
});

Deno.test("a step key reads as plain words", () => {
  assertEquals(stepName("design_signoff"), "design signoff");
  assertEquals(stepName("Design-Review"), "design review");
  assertEquals(stepName(null), "step");
  assertEquals(stepName("__"), "step");
  assertEquals(capitalized("design"), "Design");
});

Deno.test("the latest step approval is the newest of this run, decided or not", () => {
  const list = [
    approval({
      id: "old",
      status: "answered",
      createdAt: "2026-11-24T09:00:00.000Z",
    }),
    approval({ id: "new", status: "answered", decision: "reject" }),
    approval({
      id: "other",
      subjectId: "00000000-0000-4000-8000-000000000002",
    }),
    approval({ id: "plan", subjectType: "plan_revision" }),
  ];
  assertEquals(latestStepApproval(list, RUN)?.id, "new");
  assertEquals(latestStepApproval([], RUN), null);
});

Deno.test("the step an approval is about is the waiting one, else the newest", () => {
  const step = (id: string, status: string, createdAt: string) =>
    ({ id, status, createdAt }) as never;
  const steps = [
    step("s1", "completed", "2026-11-24T09:00:00.000Z"),
    step("s2", "failed", "2026-11-24T09:30:00.000Z"),
  ];
  assertEquals(approvalStep(steps)?.id, "s2");
  assertEquals(
    approvalStep([...steps, step("s3", "waiting", "2026-11-24T08:00:00.000Z")])
      ?.id,
    "s3",
  );
  assertEquals(approvalStep([]), null);
});

Deno.test("a run's outcome is read from the decision, never from its canceled status", () => {
  const decided = (decision: string, comment: string | null) =>
    approval({
      status: "answered",
      decision,
      decisionComment: comment,
      decidedBy: "p1",
    });
  assertEquals(
    runOutcome(decided("request_changes", " Cover refunds. "), "canceled"),
    {
      decision: "request_changes",
      note: "Cover refunds.",
      decidedBy: "p1",
    },
  );
  assertEquals(
    runOutcome(decided("reject", null), "canceled")?.decision,
    "reject",
  );
  assertEquals(runOutcome(decided("approve", null), "canceled"), null);
  assertEquals(runOutcome(decided("reject", null), "running"), null);
  assertEquals(runOutcome(null, "canceled"), null);
  assertEquals(decisionOf(decided("approve", null)), "approve");
  assertEquals(decisionOf(approval({})), null);
});

Deno.test("each refusal gets its own sentence key", () => {
  const of = (status: number | null, reason: string | null) =>
    refusalOf({ status, reason });
  assertEquals(of(409, "approval_decided"), "decided");
  assertEquals(of(409, "approval_superseded"), "newer");
  assertEquals(of(409, "approval_stale"), "newer");
  assertEquals(of(409, "approval_revoked"), "withdrawn");
  assertEquals(of(409, "approval_unavailable"), "closed");
  assertEquals(of(409, "approval_expired"), "closed");
  assertEquals(of(404, null), "outside");
  assertEquals(of(500, null), "failed");
  assertEquals(of(null, null), "failed");
});
