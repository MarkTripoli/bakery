/**
 * Issue 82 integration lane: recheck, advance and pause on real Postgres.
 * Transactions run as the application role; the reader is in memory. AC3 is
 * proved per trigger: the request is suspended (or resumed) with a new
 * immutable report and no lost evidence, and every applied decision writes its
 * audit row and domain event in the same transaction.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../../packages/contracts/src/http.ts";
import { approvalPolicyDigest } from "../../../apps/server/src/modules/work/stage-policy.ts";
import {
  prefetchTicketReads,
  TicketPrefetchRequiredError,
} from "../../../apps/server/src/modules/work/ticket-prefetch.ts";
import {
  findAvailableApproval,
  readSourceHandle,
  readTicketRef,
} from "../../../apps/server/src/modules/work/ticket-store.ts";
import {
  advanceRequest,
  recheckTicket,
} from "../../../apps/server/src/modules/work/ticket-admission.ts";
import { requestRunPause } from "../../../apps/server/src/modules/work/ticket-run-pause.ts";
import {
  assertNoDeadlock,
  holdRow,
  raceClaim,
  raceInOrder,
} from "../lock-race.ts";
import {
  ACCEPTANCE_BODY,
  AFTER_SINCE,
  automaticPolicy,
  EXECUTE_LABEL,
  HOLD_LABEL,
  LABELER_ID,
  seedLabeler,
  type TicketFixture,
  watchTransactions,
  withTicketFixture,
} from "./fixtures.ts";
import { ticketCall } from "./operations-http.ts";

const EDITED_BODY = `${ACCEPTANCE_BODY}- and it logs\n`;

export async function requestRow(fx: TicketFixture, requestId: string) {
  const result = await fx.owner.query<{
    disposition: string;
    disposition_reason: string | null;
    workflow_run_id: string | null;
    pause_requested_at: Date | null;
    version: number;
  }>(
    `select disposition, disposition_reason, workflow_run_id,
            pause_requested_at, version
       from bakery.ticket_requests where organization_id = $1 and id = $2`,
    [fx.organizationId, requestId],
  );
  return result.rows[0];
}

export async function reportRows(fx: TicketFixture, ticketId: string) {
  const result = await fx.owner.query<{ id: string; version: number }>(
    `select id, version from bakery.ticket_readiness_reports
      where organization_id = $1 and external_ticket_id = $2 order by version`,
    [fx.organizationId, ticketId],
  );
  return result.rows;
}

async function currentRun(fx: TicketFixture, taskId: string) {
  const result = await fx.owner.query<{ current_run_id: string | null }>(
    "select current_run_id from bakery.tasks where organization_id = $1 and id = $2",
    [fx.organizationId, taskId],
  );
  return result.rows[0].current_run_id;
}

/** One audit row and one event per applied change, the last event at the request's version. */
export async function assertFacts(
  fx: TicketFixture,
  requestId: string,
  operations: string[],
) {
  const facts = await fx.requestFacts(requestId);
  // Rows written in one transaction share a timestamp: compare as sets.
  assertEquals([...facts.audit].sort(), [...operations].sort());
  assertEquals(facts.events.length, operations.length, "one event per row");
  assertEquals(facts.events.at(-1), {
    resourceId: requestId,
    resourceVersion: (await requestRow(fx, requestId)).version,
  });
}

/** An issue as the reader answers it, labeled for execution unless overridden. */
export function setIssue(
  fx: TicketFixture,
  number: number,
  overrides: Partial<Parameters<TicketFixture["reader"]["setIssue"]>[0]> = {},
) {
  fx.reader.setIssue({ number, labels: [EXECUTE_LABEL], ...overrides });
}

/** A request admitted by webhook on an automatic source: label basis, one queued run. */
async function admitWebhook(
  fx: TicketFixture,
  sourceId: string,
  number: number,
  blocker?: string,
) {
  setIssue(fx, number);
  fx.reader.setLabelApplied(number, EXECUTE_LABEL, { appliedAt: AFTER_SINCE });
  if (blocker !== undefined) {
    fx.reader.setLinks(number, {
      blockedBy: [{
        id: blocker,
        number: 3,
        repositoryFullName: fx.repositoryFullName,
      }],
    });
    setProof(fx, blocker, "satisfied");
  }
  const admitted = await fx.admit(sourceId, { number, origin: "webhook" });
  assertEquals(admitted.kind, "admitted");
  assert(admitted.request!.workflowRunId !== null);
  return { request: admitted.request!, ticketId: admitted.ticketId! };
}

function setProof(
  fx: TicketFixture,
  blocker: string,
  proof: "satisfied" | "open" | "closed_unmerged",
) {
  fx.reader.setProof(
    blocker,
    proof === "satisfied"
      ? {
        kind: "satisfied",
        pullRequestNumber: 4,
        mergeSha: "b".repeat(40),
        mergedAt: AFTER_SINCE,
      }
      : proof === "open"
      ? { kind: "open" }
      : { kind: "closed_unmerged", stateReason: "not_planned" },
  );
}

export type Trigger = {
  name: string;
  /** The reason the suspension records. */
  reason: string;
  /** Whether a recheck resumes the request once the cause is gone. */
  resumes: boolean;
  blocker?: string;
  breakIt(fx: TicketFixture, sourceId: string, number: number): Promise<void>;
  restore(fx: TicketFixture, sourceId: string, number: number): Promise<void>;
};

/** Disables or re-enables the Developer the sources delegate to. */
export const setDeveloperDisabled = (fx: TicketFixture, disabled: boolean) =>
  fx.owner.query(
    `update bakery.principals
        set disabled_at = case when $2::boolean then now() end
      where id = $1`,
    [fx.developerId, disabled],
  ).then(() => {});

const setDeveloperRole = (fx: TicketFixture, role: string) =>
  fx.owner.query(
    `update bakery.organization_memberships set role = $3
      where organization_id = $1 and principal_id = $2`,
    [fx.organizationId, fx.developerId, role],
  ).then(() => {});

export const setAllowlist = (
  fx: TicketFixture,
  sourceId: string,
  ids: string[],
) =>
  fx.owner.query(
    `update bakery.ticket_sources
        set policy = jsonb_set(policy, '{delegation,githubActorIds}', $3::jsonb),
            policy_revision = policy_revision + 1, version = version + 1
      where organization_id = $1 and id = $2`,
    [fx.organizationId, sourceId, JSON.stringify(ids)],
  ).then(() => {});

const edit =
  (overrides: Parameters<typeof setIssue>[2]): Trigger["breakIt"] =>
  (fx, _sourceId, number) => Promise.resolve(setIssue(fx, number, overrides));

const reopen: Trigger["restore"] = (fx, _sourceId, number) =>
  Promise.resolve(setIssue(fx, number));

export const TRIGGERS: Trigger[] = [
  {
    name: "body changed, criteria still present",
    reason: "acceptance_changed",
    resumes: false,
    breakIt: edit({ body: EDITED_BODY }),
    restore: reopen,
  },
  {
    name: "title changed",
    reason: "acceptance_changed",
    resumes: false,
    breakIt: edit({ title: "Retitled" }),
    restore: reopen,
  },
  {
    name: "request label withdrawn",
    reason: "label_withdrawn",
    resumes: true,
    breakIt: edit({ labels: [] }),
    restore: reopen,
  },
  {
    name: "hold label added",
    reason: "held",
    resumes: true,
    breakIt: edit({ labels: [EXECUTE_LABEL, HOLD_LABEL] }),
    restore: reopen,
  },
  {
    name: "issue closed",
    reason: "ticket_closed",
    resumes: false,
    breakIt: edit({ state: "closed", stateReason: "completed" }),
    restore: reopen,
  },
  {
    name: "issue gone",
    reason: "ticket_gone",
    resumes: false,
    breakIt: (fx, _sourceId, number) =>
      Promise.resolve(fx.reader.setIssueRead(number, { kind: "gone" })),
    restore: reopen,
  },
  {
    name: "delegation principal deactivated",
    reason: "principal_inactive",
    resumes: true,
    breakIt: (fx) => setDeveloperDisabled(fx, true),
    restore: (fx) => setDeveloperDisabled(fx, false),
  },
  {
    name: "delegation principal demoted to viewer",
    reason: "principal_inactive",
    resumes: true,
    breakIt: (fx) => setDeveloperRole(fx, "viewer"),
    restore: (fx) => setDeveloperRole(fx, "developer"),
  },
  {
    name: "actor removed from the allowlist",
    reason: "actor_not_allowlisted",
    resumes: true,
    breakIt: (fx, sourceId) => setAllowlist(fx, sourceId, ["1"]),
    restore: (fx, sourceId) => setAllowlist(fx, sourceId, [LABELER_ID]),
  },
  {
    name: "actor role dropped to read",
    reason: "actor_role_insufficient",
    resumes: true,
    breakIt: (fx) => Promise.resolve(seedLabeler(fx, "read")),
    restore: (fx) => Promise.resolve(seedLabeler(fx)),
  },
  {
    name: "blocker reopened",
    reason: "predecessor_open",
    resumes: true,
    blocker: "5201",
    breakIt: (fx) => Promise.resolve(setProof(fx, "5201", "open")),
    restore: (fx) => Promise.resolve(setProof(fx, "5201", "satisfied")),
  },
  {
    name: "blocker closed unmerged",
    reason: "closed_unmerged",
    resumes: true,
    blocker: "5202",
    breakIt: (fx) => Promise.resolve(setProof(fx, "5202", "closed_unmerged")),
    restore: (fx) => Promise.resolve(setProof(fx, "5202", "satisfied")),
  },
  {
    name: "provider unavailable",
    reason: "provider_unavailable",
    resumes: true,
    breakIt: (fx) => Promise.resolve(fx.reader.failNext("readIssue")),
    restore: () => Promise.resolve(),
  },
];

Deno.test("issue 82 recheck AC3: each trigger suspends the request with a new report and no lost evidence; restored conditions resume only the auto-resumable reasons", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    let number = 400;
    for (const trigger of TRIGGERS) {
      number += 1;
      const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
      const { request, ticketId } = await admitWebhook(
        fx,
        sourceId,
        number,
        trigger.blocker,
      );
      const reports = await reportRows(fx, ticketId);
      const before = await fx.counts(sourceId);

      await trigger.breakIt(fx, sourceId, number);
      const suspended = await fx.recheck(ticketId);
      const label = trigger.name;
      assertEquals(suspended.applied, ["suspend"], label);
      assertEquals(suspended.request?.id, request.id, label);
      assertEquals(suspended.request?.disposition, "suspended", label);
      assertEquals(suspended.request?.dispositionReason, trigger.reason, label);
      // A run exists, so a pause was tried; nothing was live to pause.
      assertEquals(
        suspended.pause,
        { requested: false, reason: "no_live_attempt" },
        label,
      );
      // A new immutable report; every earlier report, the task, link, run and
      // request rows are kept.
      const after = await reportRows(fx, ticketId);
      assertEquals(after.length, reports.length + 1, label);
      assertEquals(after.slice(0, reports.length), reports, label);
      assertEquals(suspended.storedReport?.sequence, after.length, label);
      assertEquals(
        await fx.counts(sourceId),
        { ...before, reports: before.reports + 1 },
        label,
      );
      await assertFacts(fx, request.id, [
        "ticketRequests.create",
        "ticketRequests.suspend",
      ]);

      await trigger.restore(fx, sourceId, number);
      const restored = await fx.recheck(ticketId);
      if (trigger.resumes) {
        assertEquals(restored.applied, ["resume"], label);
        assertEquals(restored.request?.disposition, "admitted", label);
        assertEquals(restored.request?.dispositionReason, null, label);
        await assertFacts(fx, request.id, [
          "ticketRequests.create",
          "ticketRequests.suspend",
          "ticketRequests.resume",
        ]);
      } else {
        assertEquals(restored.applied, [], label);
        assertEquals(restored.request?.disposition, "suspended", label);
        assertEquals(restored.request?.dispositionReason, trigger.reason);
      }
    }
  }));

Deno.test("issue 82 recheck: explicit-only reasons stay suspended until an explicit call; re-pin only without a run", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });

    // A plan request has no run: an explicit call with the live digest re-pins it.
    setIssue(fx, 501);
    const plan = await fx.admit(sourceId, { number: 501, intent: "plan" });
    setIssue(fx, 501, { body: EDITED_BODY });
    const first = await fx.recheck(plan.ticketId!);
    assertEquals(first.request?.dispositionReason, "acceptance_changed");
    assertEquals(first.pause, null, "no run, nothing to pause");
    setIssue(fx, 501);
    assertEquals((await fx.recheck(plan.ticketId!)).applied, [], "stays");
    setIssue(fx, 501, { body: EDITED_BODY });
    const live = (await fx.recheck(plan.ticketId!)).report!.requirementsDigest;
    const repinned = await fx.admit(sourceId, {
      number: 501,
      intent: "plan",
      requirementsDigest: live,
    });
    assertEquals(repinned.kind, "repinned");
    assertEquals(repinned.request?.disposition, "waiting");

    // A start request owns a run: re-pinning is refused, resuming in place is not.
    setIssue(fx, 502);
    const start = await fx.admit(sourceId, { number: 502, intent: "start" });
    setIssue(fx, 502, { body: EDITED_BODY });
    const held = await fx.recheck(start.ticketId!);
    assertEquals(held.request?.disposition, "suspended");
    const refused = await assertRejects(() =>
      fx.admit(sourceId, {
        number: 502,
        intent: "start",
        requirementsDigest: held.report!.requirementsDigest,
      })
    );
    assert(refused instanceof StandardError);
    assertEquals(refused.params?.reason, "ticket_request_has_run");
    setIssue(fx, 502);
    assertEquals((await fx.recheck(start.ticketId!)).applied, []);
    const resumed = await fx.admit(sourceId, { number: 502, intent: "start" });
    assertEquals(resumed.request?.disposition, "admitted");

    // A closed issue replaces the milder reason of a request that is already
    // suspended, stays suspended after it is reopened (a returned hold label
    // does not make it resumable) and waits for a person.
    setIssue(fx, 503);
    const closed = await fx.admit(sourceId, { number: 503, intent: "start" });
    setIssue(fx, 503, { labels: [EXECUTE_LABEL, HOLD_LABEL] });
    assertEquals(
      (await fx.recheck(closed.ticketId!)).request?.dispositionReason,
      "held",
    );
    setIssue(fx, 503, {
      labels: [EXECUTE_LABEL, HOLD_LABEL],
      state: "closed",
      stateReason: "completed",
    });
    const replaced = await fx.recheck(closed.ticketId!);
    assertEquals(replaced.applied, ["suspend"]);
    assertEquals(replaced.request?.dispositionReason, "ticket_closed");
    setIssue(fx, 503, { labels: [EXECUTE_LABEL, HOLD_LABEL] });
    assertEquals((await fx.recheck(closed.ticketId!)).applied, [], "held");
    setIssue(fx, 503);
    assertEquals((await fx.recheck(closed.ticketId!)).applied, []);
    const reopened = await fx.admit(sourceId, { number: 503, intent: "start" });
    assertEquals(reopened.request?.disposition, "admitted");
    assertEquals(reopened.request?.dispositionReason, null);
  }));

Deno.test("issue 82 recheck: label events that do not cover the request label leave a manual request alone; a healthy manual or adoption request is never suspended for a missing delegation", () =>
  withTicketFixture(async (fx) => {
    // No delegation: a poll or webhook judged the way it was admitted passes;
    // judged as itself it would wait on no_delegation.
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    setIssue(fx, 601);
    const manual = await fx.admit(sourceId, { number: 601, intent: "start" });
    setIssue(fx, 602);
    const labeled = await fx.admit(sourceId, {
      number: 602,
      origin: "adoption",
      intent: null,
    });
    assertEquals(labeled.request?.authorityEvidence.labelBasis, "label");
    setIssue(fx, 603, { labels: [] });
    const unlabeled = await fx.admit(sourceId, {
      number: 603,
      origin: "adoption",
      intent: "plan",
    });
    assertEquals(unlabeled.request?.authorityEvidence.labelBasis, "manual");
    const all = [manual, labeled, unlabeled];

    for (const origin of ["poll", "webhook"] as const) {
      for (const admitted of all) {
        const result = await fx.recheck(admitted.ticketId!, { origin });
        assertEquals(
          result.applied,
          [],
          `${origin} ${admitted.request?.origin}`,
        );
        assertEquals(
          result.request?.disposition,
          admitted.request?.disposition,
        );
      }
    }
    const reportsBefore = (await fx.counts(sourceId)).reports;

    // Labels that do not cover `ready for agent` (an unrelated label, then
    // none) do not touch a manual basis; the adoption on the label basis
    // suspends on the label alone.
    for (const labels of [["bug"], []]) {
      for (const number of [601, 602, 603]) setIssue(fx, number, { labels });
      for (const admitted of all) await fx.recheck(admitted.ticketId!);
    }
    const dispositions = await Promise.all(
      all.map(async (admitted) => {
        const row = await requestRow(fx, admitted.request!.id);
        return [row.disposition, row.disposition_reason];
      }),
    );
    assertEquals(dispositions, [
      ["admitted", null],
      ["suspended", "label_withdrawn"],
      ["waiting", null],
    ]);
    assertEquals(
      (await fx.counts(sourceId)).reports,
      reportsBefore + 1,
      "only the label-basis request has a new basis",
    );
  }));

/** A live job attempt on a worker host for the run's first step, as the worker would hold it. */
async function seedAttempt(
  fx: TicketFixture,
  runId: string,
  adapterCapabilities: string[],
) {
  const ids = {
    job: crypto.randomUUID(),
    principal: crypto.randomUUID(),
    host: crypto.randomUUID(),
    attempt: crypto.randomUUID(),
    session: crypto.randomUUID(),
  };
  const step = await fx.owner.query<{ id: string }>(
    `select id from bakery.run_steps where organization_id = $1 and run_id = $2
      order by position, iteration limit 1`,
    [fx.organizationId, runId],
  );
  const org = fx.organizationId;
  await fx.owner.query(
    `insert into bakery.jobs (id, organization_id, run_step_id, action, input,
       requirements, status, current_fence)
     values ($1, $2, $3, 'harness.implement', '{}', '{}', 'running', 1)`,
    [ids.job, org, step.rows[0].id],
  );
  await fx.owner.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, 'Pause test worker', 'worker')`,
    [ids.principal],
  );
  await fx.owner.query(
    `insert into bakery.worker_hosts (id, organization_id, principal_id,
       principal_type, name, os, architecture, capabilities, slots,
       credential_hash, worker_session_id, worker_session_generation,
       adapter_capabilities)
     values ($1, $2, $3, 'worker', 'Pause test host', 'linux', 'x64', '[]', 1,
       $4, $5, 0, $6::jsonb)`,
    [
      ids.host,
      org,
      ids.principal,
      `pause-${ids.host}`,
      ids.session,
      JSON.stringify(adapterCapabilities),
    ],
  );
  await fx.owner.query(
    `insert into bakery.job_attempts (id, organization_id, job_id,
       worker_host_id, worker_session_id, worker_session_generation, attempt_no,
       fence, lease_token_hash, lease_expires_at, status, started_at)
     values ($1, $2, $3, $4, $5, 0, 1, 1, $6,
       clock_timestamp() + interval '5 minutes', 'running', clock_timestamp())`,
    [ids.attempt, org, ids.job, ids.host, ids.session, `lease-${ids.attempt}`],
  );
  const commands = async () =>
    (await fx.owner.query<{ idempotency_key: string; command_type: string }>(
      `select idempotency_key, command_type from bakery.worker_commands
        where organization_id = $1 and attempt_id = $2`,
      [org, ids.attempt],
    )).rows;
  const cleanup = async () => {
    await fx.owner.query(
      "delete from bakery.worker_commands where attempt_id = $1",
      [ids.attempt],
    );
    await fx.owner.query("delete from bakery.job_attempts where id = $1", [
      ids.attempt,
    ]);
    await fx.owner.query("delete from bakery.jobs where id = $1", [ids.job]);
    await fx.owner.query("delete from bakery.worker_hosts where id = $1", [
      ids.host,
    ]);
    await fx.owner.query("delete from bakery.principals where id = $1", [
      ids.principal,
    ]);
  };
  return { commands, cleanup };
}

Deno.test("issue 82 recheck: a run that outlives its request's suspension is paused once, only when a command was enqueued", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    const attempts: { cleanup(): Promise<void> }[] = [];
    try {
      // A live attempt on a worker that can steer: one pause command.
      const a = await admitWebhook(fx, sourceId, 701);
      const live = await seedAttempt(fx, a.request.workflowRunId!, ["steer"]);
      attempts.push(live);
      setIssue(fx, 701, { labels: [] });
      const paused = await fx.recheck(a.ticketId);
      assertEquals(paused.applied, ["suspend", "pause"]);
      assertEquals(paused.pause, { requested: true });
      assert((await requestRow(fx, a.request.id)).pause_requested_at !== null);
      const sent = await live.commands();
      assertEquals(sent.length, 1);
      assertEquals(sent[0].command_type, "steer");
      assert(
        sent[0].idempotency_key.startsWith(`ticket-pause:${a.request.id}:`),
      );
      assertEquals((await fx.recheck(a.ticketId)).applied, [], "once");
      assertEquals((await live.commands()).length, 1);
      await assertFacts(fx, a.request.id, [
        "ticketRequests.create",
        "ticketRequests.suspend",
        "ticketRequests.pause",
      ]);
      // Resuming the request clears the mark, so a later suspension pauses again.
      setIssue(fx, 701);
      assertEquals((await fx.recheck(a.ticketId)).applied, ["resume"]);
      assertEquals(
        (await requestRow(fx, a.request.id)).pause_requested_at,
        null,
      );

      // No live attempt: nothing is marked; the next pass pauses once one exists.
      const b = await admitWebhook(fx, sourceId, 702);
      setIssue(fx, 702, { labels: [] });
      const none = await fx.recheck(b.ticketId);
      assertEquals(none.applied, ["suspend"]);
      assertEquals(none.pause, { requested: false, reason: "no_live_attempt" });
      assertEquals(
        (await requestRow(fx, b.request.id)).pause_requested_at,
        null,
      );
      const later = await seedAttempt(fx, b.request.workflowRunId!, ["steer"]);
      attempts.push(later);
      const retried = await fx.recheck(b.ticketId);
      assertEquals(retried.applied, ["pause"]);
      assertEquals((await later.commands()).length, 1);
      // The key names the request and its version: a replay of one version
      // enqueues nothing more, another version does.
      const again = (version: number) =>
        fx.inTransaction((tx) =>
          requestRunPause(tx, {
            organizationId: fx.organizationId,
            runId: b.request.workflowRunId!,
            traceId: crypto.randomUUID(),
            requestId: b.request.id,
            version,
          })
        );
      for (const version of [900, 900, 901]) {
        assertEquals(await again(version), { requested: true });
      }
      assertEquals((await later.commands()).length, 3);

      // An adapter that cannot steer or interrupt: no command, no mark.
      const c = await admitWebhook(fx, sourceId, 703);
      const mute = await seedAttempt(fx, c.request.workflowRunId!, []);
      attempts.push(mute);
      setIssue(fx, 703, { labels: [] });
      const unsupported = await fx.recheck(c.ticketId);
      assertEquals(unsupported.applied, ["suspend"]);
      assertEquals(unsupported.pause, {
        requested: false,
        reason: "unsupported",
      });
      assertEquals((await mute.commands()).length, 0);
      assertEquals(
        (await requestRow(fx, c.request.id)).pause_requested_at,
        null,
      );
    } finally {
      for (const attempt of attempts) await attempt.cleanup();
    }
  }));

Deno.test("issue 82 recheck: an explicit resume clears the pause mark, so the next suspension pauses the live run again", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    const closed = { state: "closed", stateReason: "completed" } as const;
    const a = await admitWebhook(fx, sourceId, 711);
    const live = await seedAttempt(fx, a.request.workflowRunId!, ["steer"]);
    try {
      setIssue(fx, 711, closed);
      assertEquals((await fx.recheck(a.ticketId)).applied, [
        "suspend",
        "pause",
      ]);
      assertEquals((await live.commands()).length, 1);
      // A closed issue is an explicit-only reason: a person resumes the request.
      setIssue(fx, 711);
      const resumed = await fx.admit(sourceId, {
        number: 711,
        intent: "start",
      });
      assertEquals(resumed.request?.disposition, "admitted");
      assertEquals(
        (await requestRow(fx, a.request.id)).pause_requested_at,
        null,
      );
      // The mark is gone, so the next suspension pauses the same run once more.
      setIssue(fx, 711, closed);
      assertEquals((await fx.recheck(a.ticketId)).applied, [
        "suspend",
        "pause",
      ]);
      assertEquals((await live.commands()).length, 2);
    } finally {
      await live.cleanup();
    }

    // A re-pin returns a request to `waiting` and clears the mark as well. No
    // pause can mark a request without a run, so the mark is seeded.
    setIssue(fx, 712);
    const plan = await fx.admit(sourceId, { number: 712, intent: "plan" });
    setIssue(fx, 712, { body: EDITED_BODY });
    const edited = await fx.recheck(plan.ticketId!);
    assertEquals(edited.request?.dispositionReason, "acceptance_changed");
    await fx.owner.query(
      `update bakery.ticket_requests set pause_requested_at = now()
        where organization_id = $1 and id = $2`,
      [fx.organizationId, plan.request!.id],
    );
    const repinned = await fx.admit(sourceId, {
      number: 712,
      intent: "plan",
      requirementsDigest: edited.report!.requirementsDigest,
    });
    assertEquals(repinned.kind, "repinned");
    assertEquals(
      (await requestRow(fx, plan.request!.id)).pause_requested_at,
      null,
    );
  }));

Deno.test("issue 82 recheck: a finished run ends the request; a ticket without a nonterminal request is left alone", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    setIssue(fx, 801);
    const admitted = await fx.admit(sourceId, { number: 801, intent: "start" });
    await fx.owner.query(
      `update bakery.workflow_runs set status = 'completed', finished_at = now()
        where organization_id = $1 and id = $2`,
      [fx.organizationId, admitted.request!.workflowRunId],
    );
    const ended = await fx.recheck(admitted.ticketId!);
    assertEquals(ended.applied, ["terminal"]);
    assertEquals(ended.request?.disposition, "completed");
    assertEquals(ended.request?.dispositionReason, "run_completed");
    await assertFacts(fx, admitted.request!.id, [
      "ticketRequests.create",
      "ticketRequests.end",
    ]);

    const reports = (await fx.counts(sourceId)).reports;
    const none = await fx.recheck(admitted.ticketId!);
    assertEquals(none.applied, []);
    assertEquals(none.request, null);
    assertEquals((await fx.counts(sourceId)).reports, reports);
  }));

Deno.test("issue 82 recheck: a suspended request's task refuses runs.create, and a run started by hand once it resumes is linked, not duplicated", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    setIssue(fx, 901);
    const waiting = await fx.admit(sourceId, { number: 901, intent: "start" });
    assertEquals(waiting.request?.disposition, "waiting");
    const taskId = waiting.request!.taskId;
    // The Admin's own run needs no approval once the plan stage is automatic.
    await fx.owner.query(
      `update bakery.tasks set approval_policy = '{"plan":"automatic"}'::jsonb
        where organization_id = $1 and id = $2`,
      [fx.organizationId, taskId],
    );

    setIssue(fx, 901, { labels: [EXECUTE_LABEL, HOLD_LABEL] });
    const held = await fx.recheck(waiting.ticketId!);
    assertEquals(held.applied, ["suspend"]);
    assertEquals(held.pause, null, "no run, so no pause");
    const refused = await fx.startRun(taskId);
    assertEquals(refused.status, 409, refused.text);
    assert(refused.text.includes("ticket_request_suspended"), refused.text);

    setIssue(fx, 901);
    assertEquals((await fx.recheck(waiting.ticketId!)).applied, ["resume"]);
    const byHand = await fx.startRun(taskId);
    assertEquals(byHand.status, 201, byHand.text);

    const linked = await fx.advance(waiting.request!.id);
    assertEquals(linked.applied, ["link_run"]);
    const runId = await currentRun(fx, taskId);
    assertEquals(linked.request?.workflowRunId, runId);
    assertEquals(linked.request?.disposition, "admitted");
    assertEquals((await fx.counts(sourceId)).runs, 1);
    assertEquals((await fx.advance(waiting.request!.id)).applied, []);
    await assertFacts(fx, waiting.request!.id, [
      "ticketRequests.create",
      "ticketRequests.suspend",
      "ticketRequests.resume",
      "ticketRequests.link_run",
    ]);
  }));

/**
 * A new approved plan revision (the task's latest) and an answered approval
 * for it, inserted as the owner role. `approval` overrides approval columns.
 */
async function seedPlanApproval(
  fx: TicketFixture,
  taskId: string,
  options: { approval?: Record<string, unknown> } = {},
) {
  const conversation = await fx.owner.query<{ conversation_id: string }>(
    "select conversation_id from bakery.tasks where organization_id = $1 and id = $2",
    [fx.organizationId, taskId],
  );
  const conversationId = conversation.rows[0].conversation_id;
  const revision = { id: crypto.randomUUID(), digest: "" };
  revision.digest = `plan-${revision.id}`;
  await fx.owner.query(
    `insert into bakery.plan_revisions (id, organization_id, task_id,
       conversation_id, revision, body, digest, status)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      revision.id,
      fx.organizationId,
      taskId,
      conversationId,
      (await fx.owner.query<{ next: number }>(
        `select coalesce(max(revision), 0) + 1 as next
           from bakery.plan_revisions where organization_id = $1 and task_id = $2`,
        [fx.organizationId, taskId],
      )).rows[0].next,
      JSON.stringify({
        title: "Plan",
        steps: [{ id: "s1", title: "Do the work", detail: "As described." }],
        repositoryId: null,
      }),
      revision.digest,
      "approved",
    ],
  );
  const row: Record<string, unknown> = {
    id: crypto.randomUUID(),
    organization_id: fx.organizationId,
    kind: "approval",
    conversation_id: conversationId,
    task_id: taskId,
    generation: 1,
    prompt: "Approve the plan",
    status: "answered",
    subject_type: "plan_revision",
    subject_id: revision.id,
    subject_digest: revision.digest,
    scope: JSON.stringify({ stage: "plan" }),
    policy_digest: await approvalPolicyDigest({ plan: "human_approval" }),
    decision: "approve",
    ...options.approval,
  };
  const columns = Object.keys(row);
  await fx.owner.query(
    `insert into bakery.questions (${columns.join(", ")})
     values (${
      columns.map((column, index) =>
        `$${index + 1}${column === "scope" ? "::jsonb" : ""}`
      ).join(", ")
    })`,
    Object.values(row),
  );
  return { approvalId: row.id as string, revisionId: revision.id };
}

/** A human-approval start request, waiting for its plan to be approved. */
async function admitWaiting(
  fx: TicketFixture,
  sourceId: string,
  number: number,
) {
  setIssue(fx, number);
  const admitted = await fx.admit(sourceId, { number, intent: "start" });
  assertEquals(admitted.request?.disposition, "waiting");
  return { request: admitted.request!, ticketId: admitted.ticketId! };
}

Deno.test("issue 82 advance: an approved plan starts the run once under concurrent calls, and consumes the approval once", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    const { request } = await admitWaiting(fx, sourceId, 1001);
    assertEquals((await fx.advance(request.id)).applied, [], "no approval yet");
    const { approvalId } = await seedPlanApproval(fx, request.taskId);

    const results = await Promise.all([
      fx.advance(request.id),
      fx.advance(request.id),
      fx.recheck(await requestTicket(fx, request.id)),
    ]);
    assertEquals(
      results.filter((r) => r.applied.includes("advance")).length,
      1,
      "exactly one call started the run",
    );
    const row = await requestRow(fx, request.id);
    assertEquals(row.disposition, "admitted");
    assertEquals(row.workflow_run_id, await currentRun(fx, request.taskId));
    assertEquals((await fx.counts(sourceId)).runs, 1);
    const approval = await fx.owner.query<
      { status: string; consumed_by_run_id: string | null }
    >(
      "select status, consumed_by_run_id from bakery.questions where id = $1",
      [approvalId],
    );
    assertEquals(approval.rows[0], {
      status: "consumed",
      consumed_by_run_id: row.workflow_run_id,
    });
    await assertFacts(fx, request.id, [
      "ticketRequests.create",
      "ticketRequests.advance",
    ]);
  }));

async function requestTicket(fx: TicketFixture, requestId: string) {
  const result = await fx.owner.query<{ external_ticket_id: string }>(
    "select external_ticket_id from bakery.ticket_requests where id = $1",
    [requestId],
  );
  return result.rows[0].external_ticket_id;
}

Deno.test("issue 82 advance: it applies only an advance, never on an earlier evaluation, and finds only a usable approval", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    const { request, ticketId } = await admitWaiting(fx, sourceId, 1101);
    const { approvalId } = await seedPlanApproval(fx, request.taskId);

    // The issue is held since the approval: advance starts nothing and
    // suspends nothing; recheck does the suspending.
    setIssue(fx, 1101, { labels: [EXECUTE_LABEL, HOLD_LABEL] });
    const refused = await fx.advance(request.id);
    assertEquals(refused.applied, []);
    assertEquals((await requestRow(fx, request.id)).disposition, "waiting");
    assertEquals((await fx.counts(sourceId)).runs, 0);
    assertEquals((await fx.recheck(ticketId)).applied, ["suspend"]);
    setIssue(fx, 1101);
    assertEquals((await fx.recheck(ticketId)).applied, ["resume"]);

    // An approval that is not usable is not found; the usable one is.
    const taskId = request.taskId;
    const policyDigest = await approvalPolicyDigest({ plan: "human_approval" });
    const find = () =>
      fx.inTransaction((tx) =>
        findAvailableApproval(tx, fx.organizationId, taskId, policyDigest)
      );
    await fx.owner.query("delete from bakery.questions where id = $1", [
      approvalId,
    ]);
    const unusable: Record<string, unknown>[] = [
      { revoked_at: "2026-01-01T00:00:00Z" },
      { expires_at: "2026-01-01T00:00:00Z" },
      { consumed_at: "2026-01-01T00:00:00Z" },
      { status: "open" },
      { decision: "reject" },
      { policy_digest: "other-policy" },
      { scope: JSON.stringify({ stage: "implement" }) },
      { subject_digest: "other-plan" },
    ];
    for (const approval of unusable) {
      const seeded = await seedPlanApproval(fx, taskId, { approval });
      assertEquals(await find(), null, JSON.stringify(approval));
      await fx.owner.query("delete from bakery.questions where id = $1", [
        seeded.approvalId,
      ]);
    }
    const usable = await seedPlanApproval(fx, taskId);
    assertEquals(await find(), usable.approvalId);
    // A newer approved revision supersedes it: its approval no longer matches.
    await seedPlanApproval(fx, taskId, { approval: { status: "open" } });
    assertEquals(await find(), null, "approval of a superseded revision");

    // A request that ended is not the one a later generation is advanced as.
    await fx.finishRequests(sourceId, "canceled");
    const second = await fx.admit(sourceId, { number: 1101, intent: "start" });
    assertEquals(second.request?.generation, 2);
    await seedPlanApproval(fx, second.request!.taskId);
    const ended = await fx.advance(request.id);
    assertEquals([ended.applied, ended.request], [[], null]);
    assertEquals((await fx.counts(sourceId)).runs, 0);
    assertEquals((await fx.advance(second.request!.id)).applied, ["advance"]);
  }));

Deno.test("issue 82 recheck: provider reads never happen inside a transaction, and operation mode needs its answers", () =>
  withTicketFixture(async (fx) => {
    seedLabeler(fx);
    const sourceId = await fx.insertSource({ policy: automaticPolicy(fx) });
    const { ticketId } = await admitWebhook(fx, sourceId, 1201);
    const watch = watchTransactions(fx.runtime);
    const inTransaction: string[] = [];
    fx.reader.onCall = (call) => {
      if (watch.open() > 0) inTransaction.push(call.method);
    };
    fx.reader.clearCalls();
    await fx.recheck(ticketId, { deps: fx.automationDeps(watch.database) });
    assert(watch.peak() >= 1, "the watch saw the recheck transaction");
    assert(fx.reader.calls.length >= 3, "the recheck read the provider");
    assertEquals(inTransaction, []);
    assertEquals(watch.open(), 0);
    fx.reader.onCall = null;

    // Operation mode: the caller's transaction, no reads, answers required.
    fx.reader.clearCalls();
    const call = {
      organizationId: fx.organizationId,
      ticketId,
      origin: "poll" as const,
      signal: new AbortController().signal,
    };
    const missing = await assertRejects(() =>
      fx.inTransaction((tx) =>
        recheckTicket(fx.operationDeps(tx), { ...call, prefetch: null })
      )
    );
    assert(missing instanceof TicketPrefetchRequiredError);
    assertEquals(fx.reader.calls, []);
    const pollPrefetch = async (number: number) => {
      const { source, handle } = await fx.inTransaction((tx) =>
        readSourceHandle(tx, fx.organizationId, sourceId)
      );
      return await prefetchTicketReads(
        fx.reader,
        handle,
        { number, policy: source.policy, origin: "poll" },
        call.signal,
      );
    };
    const prefetch = await pollPrefetch(1201);
    fx.reader.clearCalls();
    const result = await fx.inTransaction((tx) =>
      recheckTicket(fx.operationDeps(tx), { ...call, prefetch })
    );
    assertEquals(result.applied, []);
    assertEquals(fx.reader.calls, []);

    // The answers must be about this issue and this policy, or nothing acts.
    setIssue(fx, 1202);
    const refuse = async (answers: typeof prefetch) => {
      const error = await assertRejects(() =>
        fx.recheck(ticketId, { prefetch: answers })
      );
      assert(error instanceof StandardError);
      return error.params?.reason;
    };
    assertEquals(
      await refuse(await pollPrefetch(1202)),
      "ticket_prefetch_mismatch",
    );
    // The same number under another issue id is another ticket: nothing acts,
    // and the snapshot of the stranger is not left behind.
    setIssue(fx, 1201, { id: "9999" });
    assertEquals(
      await refuse(await pollPrefetch(1201)),
      "ticket_prefetch_mismatch",
    );
    assertEquals((await fx.counts(sourceId)).tickets, 1);
    setIssue(fx, 1201);
    await fx.owner.query(
      `update bakery.ticket_sources
          set policy = jsonb_set(policy, '{labels,execute}', '"ship it"'),
              policy_revision = policy_revision + 1, version = version + 1
        where organization_id = $1 and id = $2`,
      [fx.organizationId, sourceId],
    );
    assertEquals(await refuse(prefetch), "ticket_prefetch_stale");
  }));

const APPLICATION_LOCK =
  "select id from bakery.applications where organization_id = $1 and id = $2 for update";

Deno.test("issue 82 locks: advanceRequest and HTTP runs.create on one task never deadlock, in either order, and leave one run linked to the request", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({
      policy: fx.policy({ approval: "human_approval" }),
    });
    for (
      const { number, order } of [
        { number: 1301, order: "advance first" },
        { number: 1302, order: "runs.create first" },
      ] as const
    ) {
      const { request } = await admitWaiting(fx, sourceId, number);
      const { approvalId } = await seedPlanApproval(fx, request.taskId);
      const advance = () => fx.advance(request.id);
      const runsCreate = () => fx.startRun(request.taskId, { approvalId });
      const hold = await holdRow(fx.owner, APPLICATION_LOCK, [
        fx.organizationId,
        fx.applicationId,
      ]);
      const [first, second] = order === "advance first"
        ? await raceInOrder(fx.owner, hold, advance, runsCreate)
        : await raceInOrder(fx.owner, hold, runsCreate, advance);
      assertNoDeadlock(first);
      assertNoDeadlock(second);
      const http =
        (order === "advance first" ? second : first) as PromiseSettledResult<
          { status: number; text: string }
        >;
      assertEquals(http.status, "fulfilled", order);
      if (http.status === "fulfilled") {
        // The run is created once: the call that came second is refused.
        assertEquals(
          http.value.status,
          order === "advance first" ? 409 : 201,
          `${order}: ${http.value.text}`,
        );
      }
      const row = await requestRow(fx, request.id);
      assertEquals(row.workflow_run_id, await currentRun(fx, request.taskId));
      assert(row.workflow_run_id !== null, order);
      assertEquals(row.disposition, "admitted", order);
    }
    assertEquals((await fx.counts(sourceId)).runs, 2);
  }));

Deno.test("issue 82 locks: recheckTicket and admitTicket for one ticket never deadlock, in either order, and suspend once", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    for (
      const [number, order] of [[1401, "recheck"], [1402, "admit"]] as const
    ) {
      setIssue(fx, number);
      const admitted = await fx.admit(sourceId, { number, intent: "start" });
      // Held since admission: both calls want to suspend the same request.
      setIssue(fx, number, { labels: [EXECUTE_LABEL, HOLD_LABEL] });
      const recheck = () => fx.recheck(admitted.ticketId!);
      const admit = () => fx.admit(sourceId, { number, intent: "start" });
      const hold = await holdRow(
        fx.owner,
        "select id from bakery.external_tickets where organization_id = $1 and id = $2 for update",
        [fx.organizationId, admitted.ticketId],
      );
      const [first, second] = order === "recheck"
        ? await raceInOrder(fx.owner, hold, recheck, admit)
        : await raceInOrder(fx.owner, hold, admit, recheck);
      assertNoDeadlock(first);
      assertNoDeadlock(second);
      assertEquals([first.status, second.status], ["fulfilled", "fulfilled"]);
      const row = await requestRow(fx, admitted.request!.id);
      assertEquals(row.disposition, "suspended", order);
      assertEquals(row.disposition_reason, "held", order);
      const suspends = (await fx.requestFacts(admitted.request!.id)).audit
        .filter((operation) => operation === "ticketRequests.suspend");
      assertEquals(suspends.length, 1, `${order}: suspended once`);
    }
  }));

/** Write locks on the task and link tables held by the sessions queued behind `holdPid`. */
async function queuedWriteLocks(fx: TicketFixture, holdPid: number) {
  const result = await fx.owner.query<{ relation: string; mode: string }>(
    `select locks.relation::regclass::text as relation, locks.mode
       from pg_locks locks
       join pg_stat_activity activity on activity.pid = locks.pid
      where pg_blocking_pids(activity.pid) @> array[$1::int]
        and locks.locktype = 'relation' and locks.granted
        and locks.relation in ('bakery.tasks'::regclass,
                               'bakery.ticket_task_links'::regclass)
        and locks.mode <> 'AccessShareLock'`,
    [holdPid],
  );
  return result.rows;
}

Deno.test("issue 82 locks: ticketTaskLinks.create locks the ticket before it touches the task or the link table, and never deadlocks with recheckTicket or admitTicket", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    let number = 1500;
    for (const contender of ["recheck", "admit"] as const) {
      for (const order of ["claim-first", "other-first"] as const) {
        number += 1;
        const label = `${contender}, link ${order}`;
        setIssue(fx, number);
        const admitted = await fx.admit(sourceId, { number, intent: "start" });
        // Held since admission: the contender suspends the same request.
        setIssue(fx, number, { labels: [EXECUTE_LABEL, HOLD_LABEL] });
        const taskId = await fx.createPlainTask();
        const link = async () => {
          const response = await ticketCall(
            fx,
            "POST",
            `/v1/external-tickets/${admitted.ticketId}/links`,
            { body: { taskId, role: "reference" } },
          );
          return { status: response.status, text: await response.text() };
        };
        const contend = () =>
          contender === "recheck"
            ? fx.recheck(admitted.ticketId!)
            : fx.admit(sourceId, { number, intent: "start" });
        const hold = await holdRow(
          fx.owner,
          "select id from bakery.external_tickets where organization_id = $1 and id = $2 for update",
          [fx.organizationId, admitted.ticketId],
        );
        // With the link alone queued behind the ticket, it has written nothing.
        // Read here, asserted after the race: a throw inside it would leave
        // the hold open and the fixture's teardown waiting on it.
        let queuedLocks: unknown[] = [];
        const inspected = async () => {
          queuedLocks = await queuedWriteLocks(fx, hold.pid);
          return await contend();
        };
        const [linked, contended] = await raceClaim(
          fx.owner,
          hold,
          order,
          link,
          order === "claim-first" ? inspected : contend,
        );
        assertEquals(
          queuedLocks,
          [],
          `${label}: the link wrote before it locked`,
        );
        assertNoDeadlock(linked);
        assertNoDeadlock(contended);
        assertEquals([linked.status, contended.status], [
          "fulfilled",
          "fulfilled",
        ], label);
        if (linked.status === "fulfilled") {
          assertEquals(linked.value.status, 201, linked.value.text);
        }
        const row = await requestRow(fx, admitted.request!.id);
        assertEquals([row.disposition, row.disposition_reason], [
          "suspended",
          "held",
        ], label);
      }
    }
    assertEquals(
      (await fx.counts(sourceId)).links,
      8,
      "one primary and one reference link each",
    );
  }));

Deno.test("issue 82 recheck: another organization finds neither the ticket nor the request, through recheck, advance or the ticket reference", () =>
  withTicketFixture(async (fx) => {
    const sourceId = await fx.insertSource({ policy: fx.policy() });
    setIssue(fx, 1501);
    const admitted = await fx.admit(sourceId, { number: 1501, intent: "plan" });
    const requestId = admitted.request!.id;
    const foreign = crypto.randomUUID();
    const signal = new AbortController().signal;
    const before = await requestRow(fx, requestId);
    const refused = async (work: () => Promise<unknown>) => {
      const error = await assertRejects(work);
      assert(error instanceof StandardError);
      assertEquals(error.code, "RESOURCE_NOT_FOUND");
    };

    await refused(() =>
      recheckTicket(fx.automationDeps(), {
        organizationId: foreign,
        ticketId: admitted.ticketId!,
        origin: "poll",
        prefetch: null,
        signal,
      })
    );
    await refused(() =>
      advanceRequest(fx.automationDeps(), {
        organizationId: foreign,
        requestId,
        prefetch: null,
        signal,
      })
    );
    // The reference carries its own organization predicate, not only the locks after it.
    await fx.inTransaction(async (transaction) => {
      const own = await readTicketRef(
        transaction,
        fx.organizationId,
        admitted.ticketId!,
      );
      assertEquals(own.number, 1501);
      await refused(() =>
        readTicketRef(transaction, foreign, admitted.ticketId!)
      );
    });
    assertEquals(await requestRow(fx, requestId), before);
  }));
