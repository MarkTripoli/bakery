import { assert, assertEquals } from "@std/assert";
import {
  activeElapsedMs,
  APPROVAL_EXPIRED_OUTCOME,
  approvalExpired,
  CHANGES_REQUESTED_OUTCOME,
  NO_RESOLVABLE_APPROVER,
  outcomeForDecision,
  REJECTED_OUTCOME,
  resolveApprover,
} from "../../apps/server/src/modules/work/human-approval.ts";

/**
 * The rules a human.approval step applies. Each test here pins a decision whose
 * alternative is a silent behaviour change, which is why they assert the negative
 * case as carefully as the positive one.
 */

Deno.test("the workflow owner is the default approver", () => {
  const resolution = resolveApprover({
    audience: undefined,
    ownerPrincipalId: "owner-1",
  });
  assertEquals(resolution, {
    resolved: true,
    approverPrincipalIds: ["owner-1"],
  });
});

Deno.test("an explicit audience outranks the owner", () => {
  // An author who named who may decide meant those people, so the owner does not
  // override them.
  const resolution = resolveApprover({
    audience: ["reviewer-1"],
    ownerPrincipalId: "owner-1",
  });
  assertEquals(resolution, {
    resolved: true,
    approverPrincipalIds: ["reviewer-1"],
  });
});

Deno.test("no owner and no audience is refused by name, never widened to admin", () => {
  const resolution = resolveApprover({
    audience: undefined,
    ownerPrincipalId: null,
  });
  assert(!resolution.resolved);
  assertEquals(resolution.refusal, NO_RESOLVABLE_APPROVER);
  assertEquals(NO_RESOLVABLE_APPROVER, "no-resolvable-approver");
});

Deno.test("an empty audience falls back to the owner rather than refusing", () => {
  // An empty list is the shape a client sends for "nobody named specifically",
  // so it must behave like an absent one instead of silently refusing.
  const resolution = resolveApprover({
    audience: [],
    ownerPrincipalId: "owner-2",
  });
  assertEquals(resolution, {
    resolved: true,
    approverPrincipalIds: ["owner-2"],
  });
});

Deno.test("an owner who is not an active member here is refused, not accepted", () => {
  // The owner id came from the run, not from a membership check. Accepting it
  // because it was supplied would address the approval to someone who cannot
  // answer, and the wait would expire instead of the step refusing.
  const resolution = resolveApprover({
    audience: undefined,
    ownerPrincipalId: "owner-inactive",
    principals: new Set(["someone-else"]),
  });
  assert(!resolution.resolved);
  assertEquals(resolution.refusal, NO_RESOLVABLE_APPROVER);

  // The same owner is accepted when they are active: the refusal is about
  // membership, not about owners being distrusted.
  const active = resolveApprover({
    audience: undefined,
    ownerPrincipalId: "owner-active",
    principals: new Set(["owner-active"]),
  });
  assertEquals(active, {
    resolved: true,
    approverPrincipalIds: ["owner-active"],
  });
});

Deno.test("an audience entry that is not an active member is dropped, and can leave nobody", () => {
  // A removed member is still a row, so the id resolves to a principal while
  // the person cannot act. Every inactive entry must be filtered, or the
  // approval names a quorum that can never convene.
  const partly = resolveApprover({
    audience: ["member-inactive", "member-active"],
    ownerPrincipalId: null,
    principals: new Set(["member-active"]),
  });
  assertEquals(partly, {
    resolved: true,
    approverPrincipalIds: ["member-active"],
  });

  const nobody = resolveApprover({
    audience: ["member-inactive"],
    ownerPrincipalId: null,
    principals: new Set(),
  });
  assert(!nobody.resolved);
  assertEquals(nobody.refusal, NO_RESOLVABLE_APPROVER);
});

Deno.test("reject and request changes end with different names", () => {
  assertEquals(outcomeForDecision("reject"), REJECTED_OUTCOME);
  assertEquals(
    outcomeForDecision("request_changes"),
    CHANGES_REQUESTED_OUTCOME,
  );
  assert(
    (REJECTED_OUTCOME as string) !== (CHANGES_REQUESTED_OUTCOME as string),
    "a single generic name would collapse two different next steps",
  );
});

Deno.test("approving continues the run, so it produces no terminal outcome", () => {
  assertEquals(outcomeForDecision("approve"), null);
});

Deno.test("a wait is excluded from the active clock while wall time includes it", () => {
  const now = new Date("2026-01-08T00:00:00.000Z");
  const waitStart = new Date("2026-01-01T00:00:00.000Z");
  // The wait spans the whole measured period, so every millisecond of wall time
  // is waiting and none of it is work.
  const waitEnd = new Date("2026-01-08T00:00:00.000Z");
  const wallElapsedMs = 7 * 24 * 60 * 60 * 1000;

  const active = activeElapsedMs({
    wallElapsedMs,
    waits: [{ startedAt: waitStart, endedAt: waitEnd }],
    now,
  });

  // The pair is the point: seven days passed, and none of it was work.
  assertEquals(active, 0);
  assertEquals(wallElapsedMs, 7 * 24 * 60 * 60 * 1000);
});

Deno.test("an open wait is excluded as it happens, not only once closed", () => {
  // A run waiting right now must not accrue budget or budget time. If only
  // closed waits counted, every in-flight wait would be charged until it ended.
  const now = new Date("2026-01-01T02:00:00.000Z");
  const active = activeElapsedMs({
    wallElapsedMs: 2 * 60 * 60 * 1000,
    waits: [{ startedAt: new Date("2026-01-01T00:30:00.000Z"), endedAt: null }],
    now,
  });
  assertEquals(active, 30 * 60 * 1000);
});

Deno.test("waits are additive and never produce negative active time", () => {
  const now = new Date("2026-01-01T03:00:00.000Z");
  const active = activeElapsedMs({
    wallElapsedMs: 60 * 60 * 1000,
    // Both waits sit inside the measured span, so both are excluded.
    spanStartedAt: new Date("2026-01-01T02:00:00.000Z"),
    waits: [
      {
        startedAt: new Date("2026-01-01T02:00:00.000Z"),
        endedAt: new Date("2026-01-01T02:10:00.000Z"),
      },
      {
        startedAt: new Date("2026-01-01T02:20:00.000Z"),
        endedAt: new Date("2026-01-01T02:25:00.000Z"),
      },
    ],
    now,
  });
  // One hour of wall time, fifteen minutes of it spent waiting.
  assertEquals(active, 45 * 60 * 1000);

  // A row that claims more waiting than the run has existed is clamped, so
  // misordered or overlapping data cannot make the run appear to go backwards.
  const clamped = activeElapsedMs({
    wallElapsedMs: 1000,
    waits: [{ startedAt: new Date("2026-01-01T00:00:00.000Z"), endedAt: now }],
    now,
  });
  assertEquals(clamped, 0);
});

Deno.test("a wait from outside the measured span is clipped, not charged to it", () => {
  // The run is measured over the hour after 02:00, but the wait began at 00:00
  // and is still open. Counting the wait whole would subtract two hours from a
  // one-hour span and drive the result to zero, hiding real work.
  const now = new Date("2026-01-01T03:00:00.000Z");
  const active = activeElapsedMs({
    wallElapsedMs: 60 * 60 * 1000,
    spanStartedAt: new Date("2026-01-01T02:00:00.000Z"),
    waits: [{ startedAt: new Date("2026-01-01T00:00:00.000Z"), endedAt: null }],
    now,
  });
  // The wait covers the whole span, so all of it was waiting.
  assertEquals(active, 0);

  // The same wait, clipped to a span it only partly covers: the first ten
  // minutes are waiting, the rest is work.
  const partial = activeElapsedMs({
    wallElapsedMs: 60 * 60 * 1000,
    spanStartedAt: new Date("2026-01-01T02:00:00.000Z"),
    waits: [{
      startedAt: new Date("2026-01-01T01:55:00.000Z"),
      endedAt: new Date("2026-01-01T02:10:00.000Z"),
    }],
    now,
  });
  assertEquals(partial, 50 * 60 * 1000);
});

Deno.test("overlapping waits are subtracted once, not twice", () => {
  // Two open approvals on the same run can overlap. Summing the intervals would
  // subtract the overlap twice and make the run look shorter than the time it
  // actually worked.
  const now = new Date("2026-01-01T02:00:00.000Z");
  const active = activeElapsedMs({
    wallElapsedMs: 60 * 60 * 1000,
    spanStartedAt: new Date("2026-01-01T01:00:00.000Z"),
    waits: [
      {
        startedAt: new Date("2026-01-01T01:00:00.000Z"),
        endedAt: new Date("2026-01-01T01:30:00.000Z"),
      },
      {
        // Entirely inside the first: contributes nothing additional.
        startedAt: new Date("2026-01-01T01:10:00.000Z"),
        endedAt: new Date("2026-01-01T01:20:00.000Z"),
      },
    ],
    now,
  });
  assertEquals(active, 30 * 60 * 1000);

  // Partial overlap merges to the union: 01:00-01:30 and 01:20-01:45 is one
  // 45-minute wait, not 55 minutes of waiting.
  const partial = activeElapsedMs({
    wallElapsedMs: 60 * 60 * 1000,
    spanStartedAt: new Date("2026-01-01T01:00:00.000Z"),
    waits: [
      {
        startedAt: new Date("2026-01-01T01:00:00.000Z"),
        endedAt: new Date("2026-01-01T01:30:00.000Z"),
      },
      {
        startedAt: new Date("2026-01-01T01:20:00.000Z"),
        endedAt: new Date("2026-01-01T01:45:00.000Z"),
      },
    ],
    now,
  });
  assertEquals(partial, 15 * 60 * 1000);
});

Deno.test("a wait expires into its own named outcome, not a failure", () => {
  const limitMs = 7 * 24 * 60 * 60 * 1000;
  const startedAt = new Date("2026-01-01T00:00:00.000Z");

  assert(
    !approvalExpired({
      startedAt,
      now: new Date("2026-01-07T00:00:00.000Z"),
      limitMs,
    }),
  );
  assert(approvalExpired({
    startedAt,
    now: new Date("2026-01-08T00:00:00.000Z"),
    limitMs,
  }));
  // Expiry has a name of its own, so a reader can tell "nobody answered" from
  // "something went wrong".
  assertEquals(APPROVAL_EXPIRED_OUTCOME, "approval_expired");
  assert((APPROVAL_EXPIRED_OUTCOME as string) !== (REJECTED_OUTCOME as string));
});
