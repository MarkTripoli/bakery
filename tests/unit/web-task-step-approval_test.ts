import { assertEquals } from "@std/assert";
import {
  capitalized,
  documentVersion,
  minutesLeft,
  openStepApproval,
  refusalOf,
  stepName,
  waitingStep,
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

Deno.test("the waiting step is the newest one that waits", () => {
  const steps = [
    { id: "s1", status: "completed", createdAt: "2026-11-24T09:00:00.000Z" },
    { id: "s2", status: "waiting", createdAt: "2026-11-24T09:30:00.000Z" },
    { id: "s3", status: "waiting", createdAt: "2026-11-24T09:45:00.000Z" },
  ] as never[];
  assertEquals(waitingStep(steps)?.id, "s3");
  assertEquals(waitingStep(steps.slice(0, 1)), null);
});

Deno.test("a step key reads as plain words", () => {
  assertEquals(stepName("design_signoff"), "design signoff");
  assertEquals(stepName("Design-Review"), "design review");
  assertEquals(stepName(null), "step");
  assertEquals(stepName("__"), "step");
  assertEquals(capitalized("design"), "Design");
});

Deno.test("the document is the newest text version from another step of the run", () => {
  const version = (
    id: string,
    runStepId: string | null,
    mediaType: string,
    createdAt: string,
  ) => ({ id, runStepId, mediaType, createdAt }) as never;
  const versions = [
    version("v1", "s1", "text/markdown", "2026-11-24T09:00:00.000Z"),
    version("v2", "s1", "text/markdown", "2026-11-24T09:10:00.000Z"),
    version("v3", "s2", "text/markdown", "2026-11-24T09:20:00.000Z"),
    version("v4", "s1", "image/png", "2026-11-24T09:30:00.000Z"),
    version("v5", "x9", "text/markdown", "2026-11-24T09:40:00.000Z"),
    version("v6", null, "text/markdown", "2026-11-24T09:50:00.000Z"),
  ];
  const ids = new Set(["s1", "s2"]);
  assertEquals(
    documentVersion(versions, ids, "s2") as unknown as { id: string },
    versions[1],
  );
  assertEquals(
    documentVersion(versions, ids, null) as unknown as { id: string },
    versions[2],
  );
  assertEquals(documentVersion([], ids, null), null);
});

Deno.test("time left is said in the largest whole unit", () => {
  const now = Date.parse("2026-11-24T10:00:00.000Z");
  const at = (ms: number) => new Date(now + ms).toISOString();
  assertEquals(minutesLeft(at(7 * 86_400_000), now), {
    unit: "days",
    count: 7,
  });
  assertEquals(minutesLeft(at(3 * 3_600_000 + 5_000), now), {
    unit: "hours",
    count: 3,
  });
  assertEquals(minutesLeft(at(90_000), now), { unit: "minutes", count: 1 });
  assertEquals(minutesLeft(at(-5_000), now), { unit: "minutes", count: 0 });
  assertEquals(minutesLeft(null, now), null);
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
