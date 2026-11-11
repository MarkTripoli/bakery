/**
 * Issue 82 integration lane: the explicit resume of a request suspended for lost
 * authority (decision D1), on real Postgres. These cases moved out of
 * `recheck-integration.ts` and share its fixtures.
 */
import { assert, assertEquals } from "@std/assert";
import {
  isTicketAutoResumableReason,
  type TicketReasonCode,
} from "../../../packages/contracts/src/ticket-admission.ts";
import {
  assertFacts,
  reportRows,
  requestRow,
  setAllowlist,
  setDeveloperDisabled,
  setIssue,
  type Trigger,
  TRIGGERS,
} from "./recheck-integration.ts";
import {
  AFTER_SINCE,
  automaticPolicy,
  EXECUTE_LABEL,
  LABELER_ID,
  LABELER_LOGIN,
  PLAN_LABEL,
  seedLabeler,
  type TicketFixture,
  withTicketFixture,
} from "./fixtures.ts";

// ---------------------------------------------------------------------------
// The explicit resume of a request suspended for lost authority (decision D1).
// `ticketRequests.create` on a suspended request judges the caller only, while
// the recorded origin, principal and evidence have no update grant, so every
// later recheck judges the recorded principal again. These cases pin that
// behavior for the reasons that lose the authority a request was admitted
// under; they make no claim beyond what the code does.
// ---------------------------------------------------------------------------

/** Reasons for which the recorded actor or principal no longer holds the authority. */
const AUTHORITY_REASONS: readonly TicketReasonCode[] = [
  "principal_inactive",
  "actor_not_allowlisted",
  "actor_role_insufficient",
];

/** Points the source's delegation at another principal; the recorded principal of a request is never changed. */
const setDelegate = (
  fx: TicketFixture,
  sourceId: string,
  principalId: string,
) =>
  fx.owner.query(
    `update bakery.ticket_sources
        set policy = jsonb_set(policy, '{delegation,principalId}', $3::jsonb),
            policy_revision = policy_revision + 1, version = version + 1
      where organization_id = $1 and id = $2`,
    [fx.organizationId, sourceId, JSON.stringify(principalId)],
  ).then(() => {});

/** Sets the policy delegation, or removes it with `null`; the recorded principal of a request is never changed. */
const setDelegation = (
  fx: TicketFixture,
  sourceId: string,
  delegation: { principalId: string; githubActorIds: string[] } | null,
) =>
  fx.owner.query(
    `update bakery.ticket_sources
        set policy = jsonb_set(policy, '{delegation}', $3::jsonb),
            policy_revision = policy_revision + 1, version = version + 1
      where organization_id = $1 and id = $2`,
    [fx.organizationId, sourceId, JSON.stringify(delegation)],
  ).then(() => {});

/** The two reasons the shared triggers do not cover: no delegation, and an actor the role answer does not confirm. */
const MORE_AUTHORITY_TRIGGERS: Trigger[] = [
  {
    name: "delegation removed from the policy",
    reason: "no_delegation",
    resumes: true,
    breakIt: (fx, sourceId) => setDelegation(fx, sourceId, null),
    restore: (fx, sourceId) =>
      setDelegation(fx, sourceId, {
        principalId: fx.developerId,
        githubActorIds: [LABELER_ID],
      }),
  },
  {
    name: "actor id no longer matches the collaborator answer",
    reason: "actor_unverifiable",
    resumes: true,
    // The label event names the allowlisted user, but the permission answer is
    // for another user id, so who applied the label cannot be confirmed.
    breakIt: (fx) =>
      Promise.resolve(fx.reader.setRole(LABELER_LOGIN, {
        kind: "present",
        userId: "9999",
        permission: "write",
      })),
    restore: (fx) => Promise.resolve(seedLabeler(fx)),
  },
];

const AUTHORITY_TRIGGERS = [
  ...TRIGGERS.filter((trigger) =>
    (AUTHORITY_REASONS as readonly string[]).includes(trigger.reason)
  ),
  ...MORE_AUTHORITY_TRIGGERS,
];

/** A request that owns a run, and one that has none (a plan request follows its task). */
const SHAPES = [
  {
    name: "a request that owns a run",
    intent: "start",
    label: EXECUTE_LABEL,
    runs: 1,
    resumedTo: "admitted",
  },
  {
    name: "a plan request without a run",
    intent: "plan",
    label: PLAN_LABEL,
    runs: 0,
    resumedTo: "waiting",
  },
] as const;
type Shape = typeof SHAPES[number];

/** The webhook admission of `number` on the label of `shape`, by the allowlisted labeler. */
async function admitShape(
  fx: TicketFixture,
  sourceId: string,
  number: number,
  shape: Shape,
) {
  setIssue(fx, number, { labels: [shape.label] });
  fx.reader.setLabelApplied(number, shape.label, { appliedAt: AFTER_SINCE });
  const admitted = await fx.admit(sourceId, { number, origin: "webhook" });
  assertEquals(admitted.kind, "admitted", shape.name);
  assertEquals(admitted.request?.intent, shape.intent, shape.name);
  assertEquals(
    admitted.request?.workflowRunId !== null,
    shape.runs === 1,
    shape.name,
  );
  return { request: admitted.request!, ticketId: admitted.ticketId! };
}

/** The counts of a source with its reports left out: only reports grow once a request exists. */
async function countsExceptReports(fx: TicketFixture, sourceId: string) {
  const { reports: _reports, ...rest } = await fx.counts(sourceId);
  return rest;
}

/** Who each audit row of a request is attributed to, in order. */
async function auditTrail(fx: TicketFixture, requestId: string) {
  const result = await fx.owner.query<
    { operation: string; principal_id: string }
  >(
    `select operation, principal_id from bakery.audit_events
      where organization_id = $1 and resource_type = 'ticket_request'
        and resource_id = $2 order by created_at, id`,
    [fx.organizationId, requestId],
  );
  return result.rows.map((row) => [row.operation, row.principal_id]);
}

Deno.test("issue 82 recheck pin: an explicit resume of a request suspended for lost authority lasts until the next recheck, which suspends it again; restored authority resumes it with no call", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    assertEquals(AUTHORITY_TRIGGERS.map((trigger) => trigger.reason), [
      "principal_inactive",
      "principal_inactive",
      "actor_not_allowlisted",
      "actor_role_insufficient",
      "no_delegation",
      "actor_unverifiable",
    ]);
    let number = 1600;
    for (const trigger of AUTHORITY_TRIGGERS) {
      for (const shape of SHAPES) {
        number += 1;
        const label = `${trigger.name}, ${shape.name}`;
        assert(isTicketAutoResumableReason(trigger.reason), label);
        const sourceId = await fx.insertSource({
          policy: automaticPolicy(fx),
        });
        const { request, ticketId } = await admitShape(
          fx,
          sourceId,
          number,
          shape,
        );
        const rows = await countsExceptReports(fx, sourceId);
        assertEquals(rows.runs, shape.runs, label);

        // The automatic request is suspended because the authority is gone.
        await trigger.breakIt(fx, sourceId, number);
        const suspended = await fx.recheck(ticketId);
        assertEquals(suspended.applied, ["suspend"], label);
        assertEquals(suspended.request?.dispositionReason, trigger.reason);

        // A person asks for it again. The answer is that same request, no
        // longer suspended, with no run started and none lost.
        const reports = await reportRows(fx, ticketId);
        const resumed = await fx.admit(sourceId, {
          number,
          intent: shape.intent,
        });
        assertEquals(resumed.kind, "existing", label);
        assertEquals(resumed.request?.id, request.id, label);
        assertEquals(
          [resumed.request?.disposition, resumed.request?.dispositionReason],
          [shape.resumedTo, null],
          label,
        );
        assertEquals(await countsExceptReports(fx, sourceId), rows, label);
        assertEquals(
          (await requestRow(fx, request.id)).pause_requested_at,
          null,
          label,
        );
        assertEquals(
          (await reportRows(fx, ticketId)).slice(0, reports.length),
          reports,
          `${label}: no report is lost`,
        );

        // The recorded principal and actor are judged again: the next recheck
        // suspends the request for the same reason, with the run count intact.
        const again = await fx.recheck(ticketId);
        assertEquals(again.applied, ["suspend"], label);
        assertEquals(again.request?.id, request.id, label);
        assertEquals(again.request?.disposition, "suspended", label);
        assertEquals(again.request?.dispositionReason, trigger.reason, label);
        assertEquals(await countsExceptReports(fx, sourceId), rows, label);

        if (trigger.reason === "principal_inactive") {
          // The source now delegates to a live principal. That does not reach
          // the request: a recheck judges its recorded principal, so it stays
          // suspended for the same reason and nothing is written.
          await setDelegate(fx, sourceId, fx.adminId);
          const unmoved = await fx.recheck(ticketId);
          assertEquals(unmoved.applied, [], label);
          assertEquals(unmoved.request?.id, request.id, label);
          assertEquals(
            [unmoved.request?.disposition, unmoved.request?.dispositionReason],
            ["suspended", "principal_inactive"],
            label,
          );
          assertEquals(await countsExceptReports(fx, sourceId), rows, label);
        }

        // Restored authority resumes it with no explicit call.
        await trigger.restore(fx, sourceId, number);
        const back = await fx.recheck(ticketId);
        assertEquals(back.applied, ["resume"], label);
        assertEquals(back.request?.id, request.id, label);
        assertEquals(
          [back.request?.disposition, back.request?.dispositionReason],
          [shape.resumedTo, null],
          label,
        );
        assertEquals(await countsExceptReports(fx, sourceId), rows, label);

        // The person is named on the explicit resume, the recorded principal
        // on every change a recheck made.
        assertEquals(await auditTrail(fx, request.id), [
          ["ticketRequests.create", fx.developerId],
          ["ticketRequests.suspend", fx.developerId],
          ["ticketRequests.resume", fx.adminId],
          ["ticketRequests.suspend", fx.developerId],
          ["ticketRequests.resume", fx.developerId],
        ], label);
        await assertFacts(fx, request.id, [
          "ticketRequests.create",
          "ticketRequests.suspend",
          "ticketRequests.resume",
          "ticketRequests.suspend",
          "ticketRequests.resume",
        ]);
      }
    }
  }));

const cancelTask = (fx: TicketFixture, taskId: string) =>
  fx.owner.query(
    `update bakery.tasks set status = 'canceled', updated_at = now(),
            version = version + 1
      where organization_id = $1 and id = $2`,
    [fx.organizationId, taskId],
  ).then(() => {});

Deno.test("issue 82 recheck pin: a canceled task ends a request whose recorded authority is gone, and only a live delegation admits the next generation", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    const lost = [
      {
        trigger: AUTHORITY_TRIGGERS[0],
        // The recorded principal stays disabled: the source delegates to the Admin.
        regain: (sourceId: string) => setDelegate(fx, sourceId, fx.adminId),
        newPrincipal: fx.adminId,
      },
      {
        trigger: AUTHORITY_TRIGGERS[2],
        regain: (sourceId: string) => setAllowlist(fx, sourceId, [LABELER_ID]),
        newPrincipal: fx.developerId,
      },
    ];
    let number = 1700;
    for (const { trigger, regain, newPrincipal } of lost) {
      for (const shape of SHAPES) {
        number += 1;
        const label = `${trigger.name}, ${shape.name}`;
        const sourceId = await fx.insertSource({
          policy: automaticPolicy(fx),
        });
        const first = await admitShape(fx, sourceId, number, shape);
        await trigger.breakIt(fx, sourceId, number);
        assertEquals((await fx.recheck(first.ticketId)).applied, ["suspend"]);

        // A suspended request still owns the ticket: a poll admits nothing new.
        const blocked = await fx.admit(sourceId, { number, origin: "poll" });
        assertEquals(blocked.kind, "existing", label);
        assertEquals(blocked.request?.id, first.request.id, label);
        assertEquals((await fx.counts(sourceId)).requests, 1, label);

        // The task ends: the next recheck ends the request with it.
        await cancelTask(fx, first.request.taskId);
        const ended = await fx.recheck(first.ticketId);
        assertEquals(ended.applied, ["terminal"], label);
        assertEquals(ended.request?.disposition, "canceled", label);
        assertEquals(ended.request?.dispositionReason, "task_canceled", label);
        assertEquals((await fx.counts(sourceId)).nonterminalRequests, 0);
        assertEquals(
          (await fx.recheck(first.ticketId)).applied,
          [],
          `${label}: a terminal request is left alone`,
        );

        // A new generation is judged on the source delegation: while it names
        // no live authority, the poll admits nothing and writes no request.
        const refused = await fx.admit(sourceId, { number, origin: "poll" });
        assertEquals(refused.kind, "unadmitted", label);
        assertEquals(refused.request, null, label);
        assertEquals((await fx.counts(sourceId)).requests, 1, label);

        await regain(sourceId);
        const next = await fx.admit(sourceId, { number, origin: "poll" });
        assertEquals(next.kind, "admitted", label);
        assertEquals(next.request?.generation, 2, label);
        assertEquals(next.request?.authorityPrincipalId, newPrincipal, label);
        assert(next.request?.id !== first.request.id, label);
        assert(next.request?.taskId !== first.request.taskId, label);
        const counts = await fx.counts(sourceId);
        assertEquals(
          [counts.requests, counts.nonterminalRequests, counts.tasks],
          [2, 1, 2],
          label,
        );
        assertEquals(
          (await requestRow(fx, first.request.id)).disposition,
          "canceled",
          label,
        );
        // Put the Developer back for the next case.
        await setDeveloperDisabled(fx, false);
        await setAllowlist(fx, sourceId, [LABELER_ID]);
      }
    }
  }));
