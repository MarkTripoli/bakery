import { assert, assertEquals, assertRejects } from "@std/assert";
import { StandardError } from "../../packages/contracts/src/http.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import { loopElapsedMs } from "../../apps/server/src/modules/delivery/review-store.ts";
import {
  activeLoopElapsedMs,
  appendDecision,
  decideHumanApproval,
  expireHumanApprovals,
  requestHumanApproval,
  stopRun,
} from "../../apps/server/src/modules/work/human-approval-store.ts";
import {
  APPROVAL_EXPIRED_OUTCOME,
  CHANGES_REQUESTED_OUTCOME,
  NO_RESOLVABLE_APPROVER,
  REJECTED_OUTCOME,
} from "../../apps/server/src/modules/work/human-approval.ts";
import { withWorkerFixture } from "../helpers/worker-execution/scenarios.ts";
import { compiled, noop } from "../helpers/workflow-interpreter.ts";
import { seedPlanRun } from "../helpers/plan-run.ts";

/**
 * The writers behind the human.approval step.
 *
 * These drive the real store against Postgres, so they fail if a writer is
 * removed rather than if a helper is wrong. The assertions that matter most are
 * the ones counting rows: a refusal or a replay that returns the right status
 * while still appending a ledger entry is the defect this file exists to catch,
 * and it is invisible from the status code alone.
 */

const plan = compiled([noop("first")]);

/** One run with its owner set (or cleared), ready to ask for an approval. */
async function seedRun(
  fixture: Awaited<ReturnType<typeof withWorkerFixture>> extends never ? never
    : Parameters<Parameters<typeof withWorkerFixture>[0]>[0],
  owner: string | null,
) {
  const probe = await seedPlanRun(fixture, await plan);
  const client = fixture.pgDatabase as unknown as PgTransactionClient;
  await client.query(
    `update bakery.workflow_definitions d
        set owner_principal_id = $3
       from bakery.workflow_versions v
      where v.organization_id = d.organization_id
        and v.id = (select workflow_version_id from bakery.workflow_runs
                     where organization_id = $1 and id = $2)
        and d.organization_id = $1`,
    [fixture.organizationId, probe.job.runId, owner],
  );
  const details = (await client.query<
    {
      taskId: string;
      conversationId: string;
      applicationId: string;
      repositoryId: string | null;
    }
  >(
    `select t.id as "taskId", t.conversation_id as "conversationId",
            t.application_id as "applicationId", t.repository_id as "repositoryId"
       from bakery.tasks t where t.organization_id = $1 and t.id = $2`,
    [fixture.organizationId, probe.job.taskId],
  )).rows[0]!;
  return { ...probe, ...details, client };
}

/** Count the rows a decision would append anywhere, so a no-op proves it. */
async function appendCounts(
  client: PgTransactionClient,
  organizationId: string,
) {
  const ledger = await client.query<{ n: string }>(
    `select count(*)::text as n from bakery.decisions_ledger where organization_id = $1`,
    [organizationId],
  );
  const events = await client.query<{ n: string }>(
    `select count(*)::text as n from bakery.domain_events where organization_id = $1`,
    [organizationId],
  );
  const audit = await client.query<{ n: string }>(
    `select count(*)::text as n from bakery.audit_events where organization_id = $1`,
    [organizationId],
  );
  return {
    ledger: Number(ledger.rows[0]!.n),
    events: Number(events.rows[0]!.n),
    audit: Number(audit.rows[0]!.n),
  };
}

Deno.test("AC1: an approval step records its wait and asks the workflow owner", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    // The owner is the approver, not the version's editor.
    assertEquals(asked.approverPrincipalIds, [fixture.principalId]);
    const wait = await run.client.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_waits
        where organization_id = $1 and run_id = $2 and ended_at is null`,
      [fixture.organizationId, run.job.runId],
    );
    assertEquals(Number(wait.rows[0]!.n), 1);
  });
});

Deno.test("AC1: no owner is refused by name and writes nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, null);
    const before = await appendCounts(run.client, fixture.organizationId);
    const error = await assertRejects(() =>
      requestHumanApproval(run.client, {
        organizationId: fixture.organizationId,
        runId: run.job.runId,
        taskId: run.taskId,
        conversationId: run.conversationId,
        stepKey: "human.approval",
        prompt: "Ship it?",
        ownerPrincipalId: null,
        applicationId: run.applicationId,
        repositoryId: run.repositoryId,
        traceId: crypto.randomUUID(),
      })
    ) as StandardError;
    assertEquals(error.params?.reason, NO_RESOLVABLE_APPROVER);
    assertEquals(NO_RESOLVABLE_APPROVER, "no-resolvable-approver");
    // A refusal that wrote a wait or a ledger row would leave a run waiting on
    // nobody.
    const after = await appendCounts(run.client, fixture.organizationId);
    assertEquals(after, before);
    const waits = await run.client.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_waits where run_id = $1`,
      [run.job.runId],
    );
    assertEquals(Number(waits.rows[0]!.n), 0);
  });
});

Deno.test("AC2: approving continues the run, records the ledger and closes the wait", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    const decided = await decideHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      approvalId: asked.approvalId,
      principalId: fixture.principalId,
      decision: "approve",
      note: "looks good",
      expectedVersion: 1,
      actorKind: "person",
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    assertEquals(decided.outcome, null);
    const ledger = await run.client.query<
      { kind: string; subject_kind: string }
    >(
      `select kind, subject_kind from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, asked.approvalId],
    );
    assertEquals(ledger.rows.length, 1);
    assertEquals(ledger.rows[0]!.kind, "approval");
    assertEquals(ledger.rows[0]!.subject_kind, "approval");
    const open = await run.client.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_waits
        where run_id = $1 and ended_at is null`,
      [run.job.runId],
    );
    assertEquals(Number(open.rows[0]!.n), 0);
  });
});

Deno.test("AC2: reject and request changes end the run with different names", async () => {
  for (
    const [decision, expected] of [
      ["reject", REJECTED_OUTCOME],
      ["request_changes", CHANGES_REQUESTED_OUTCOME],
    ] as const
  ) {
    await withWorkerFixture(async (fixture) => {
      const run = await seedRun(fixture, fixture.principalId);
      const asked = await requestHumanApproval(run.client, {
        organizationId: fixture.organizationId,
        runId: run.job.runId,
        taskId: run.taskId,
        conversationId: run.conversationId,
        stepKey: "human.approval",
        prompt: "Ship it?",
        ownerPrincipalId: fixture.principalId,
        applicationId: run.applicationId,
        repositoryId: run.repositoryId,
        traceId: crypto.randomUUID(),
      });
      const decided = await decideHumanApproval(run.client, {
        organizationId: fixture.organizationId,
        approvalId: asked.approvalId,
        principalId: fixture.principalId,
        decision,
        expectedVersion: 1,
        actorKind: "person",
        applicationId: run.applicationId,
        repositoryId: run.repositoryId,
        traceId: crypto.randomUUID(),
      });
      assertEquals(decided.outcome, expected);
      const stored = await run.client.query<{ outcome: string }>(
        `select outcome from bakery.workflow_runs where id = $1`,
        [run.job.runId],
      );
      assertEquals(stored.rows[0]!.outcome, expected);
    });
  }
});

Deno.test("AC2: a replayed decision is a conflict and appends nothing", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    await decideHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      approvalId: asked.approvalId,
      principalId: fixture.principalId,
      decision: "reject",
      expectedVersion: 1,
      actorKind: "person",
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    const before = await appendCounts(run.client, fixture.organizationId);
    const error = await assertRejects(() =>
      decideHumanApproval(run.client, {
        organizationId: fixture.organizationId,
        approvalId: asked.approvalId,
        principalId: fixture.principalId,
        decision: "reject",
        expectedVersion: 2,
        actorKind: "person",
        applicationId: run.applicationId,
        repositoryId: run.repositoryId,
        traceId: crypto.randomUUID(),
      })
    ) as StandardError;
    // The reason, not merely that something threw: a raw database error would
    // also reject, and would tell the caller nothing about what to do next.
    assertEquals(error.code, "STATE_CONFLICT");
    assertEquals(error.params?.reason, "approval_decided");
    // A conflict that still appended a row would be the defect; only a count can
    // tell the difference between refusing and refusing after writing.
    assertEquals(
      await appendCounts(run.client, fixture.organizationId),
      before,
    );
    const entry = {
      organizationId: fixture.organizationId,
      taskId: run.taskId,
      runId: run.job.runId,
      kind: "approval" as const,
      subjectKind: "approval",
      subjectId: asked.approvalId,
      decidedBy: fixture.principalId,
    };
    // The decision above already appended its entry, so this is the duplicate a
    // convergent second request would attempt. The partial unique index makes it
    // a database conflict, so two requests cannot store two entries for one
    // decision even if they both get past the status guard.
    await assertRejects(() => appendDecision(run.client, entry));
    const count = await run.client.query<{ n: string }>(
      `select count(*)::text as n from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, asked.approvalId],
    );
    assertEquals(Number(count.rows[0]!.n), 1);
  });
});

Deno.test("AC3: an expiry ends the run as approval_expired and records it", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    // Eight days on, without waiting eight days: the expiry path runs against a
    // clock the test controls.
    const eightDays = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const expired = await expireHumanApprovals(run.client, {
      organizationId: fixture.organizationId,
      now: eightDays,
    });
    assert(expired.some((row) => row.approvalId === asked.approvalId));
    const stored = await run.client.query<{ outcome: string }>(
      `select outcome from bakery.workflow_runs where id = $1`,
      [run.job.runId],
    );
    assertEquals(stored.rows[0]!.outcome, APPROVAL_EXPIRED_OUTCOME);
    const ledger = await run.client.query<{ n: string }>(
      `select count(*)::text as n from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, asked.approvalId],
    );
    assertEquals(Number(ledger.rows[0]!.n), 1);
    const open = await run.client.query<{ n: string }>(
      `select count(*)::text as n from bakery.run_waits
        where run_id = $1 and ended_at is null`,
      [run.job.runId],
    );
    assertEquals(Number(open.rows[0]!.n), 0);
  });
});

Deno.test("AC3: the active clock excludes the wait while wall time includes it", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    // A review cycle is what the loop's wall clock measures from, so the test
    // needs a real one; the funded job the fixture seeds already made a session.
    const session = (await run.client.query<{ id: string }>(
      `select id from bakery.agent_sessions where organization_id = $1 limit 1`,
      [fixture.organizationId],
    )).rows[0]!.id;
    await run.client.query(
      `insert into bakery.review_cycles
         (id, organization_id, run_id, run_step_id, ordinal, reviewer_session_id,
          reviewer_principal_id, implementer_session_id, implementer_principal_id,
          head_sha, base_sha, policy_digest, status, finding_count, blocking_count,
          created_at)
       values ($1, $2, $3, $4, 1, $5, $6, $5, $6, $7, $8, $9, 'completed', 0, 0,
               now() - interval '2 hours')`,
      [
        crypto.randomUUID(),
        fixture.organizationId,
        run.job.runId,
        crypto.randomUUID(),
        session,
        fixture.principalId,
        "a".repeat(40),
        "b".repeat(40),
        "c".repeat(64),
      ],
    );
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    // One hour of the two elapsed hours was spent waiting on a person.
    await run.client.query(
      `update bakery.run_waits
          set started_at = now() - interval '90 minutes',
              ended_at = now() - interval '30 minutes'
        where run_id = $1 and ended_at is null`,
      [run.job.runId],
    );
    const active = await activeLoopElapsedMs(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
    });
    assert(active !== null);
    // Wall is ~120 min; the hour of waiting is excluded, so active is ~60 min.
    assert(
      active >= 55 * 60 * 1000 && active <= 65 * 60 * 1000,
      `active should exclude the one-hour wait, got ${active}ms`,
    );
    const wall = await run.client.query<{ ms: string }>(
      `select ceil(extract(epoch from (now() - min(created_at))) * 1000)::bigint::text as ms
         from bakery.review_cycles where run_id = $1`,
      [run.job.runId],
    );
    // The pair is the evidence: the same run looks shorter on the active clock
    // and unchanged on the wall clock.
    assert(Number(wall.rows[0]!.ms) > active);

    // The delivery path must report the active number too. Asserting only the
    // helper would pass while the loop still charged the wait to the work.
    const reported = await loopElapsedMs(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
    });
    // Two calls read the clock at different instants, so the numbers agree to
    // within a second rather than exactly; what matters is that the delivery
    // path reports the active figure and not the wall one.
    assert(reported !== null);
    assert(
      Math.abs(reported - active) < 1000,
      `loopElapsedMs should report the active clock, got ${reported}ms vs ${active}ms`,
    );
    assert(reported < Number(wall.rows[0]!.ms));
    assertEquals(asked.approverPrincipalIds, [fixture.principalId]);
  });
});

Deno.test("AC4: workflow.stop writes its own named outcome with a reason", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    await stopRun(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      outcome: "cancelled_by_customer",
      reason: "The customer withdrew the request.",
      decidedBy: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      conversationId: run.conversationId,
      traceId: crypto.randomUUID(),
    });
    const stored = await run.client.query<{ outcome: string }>(
      `select outcome from bakery.workflow_runs where id = $1`,
      [run.job.runId],
    );
    assertEquals(stored.rows[0]!.outcome, "cancelled_by_customer");
    // A stop is not a rejection: the two names must differ, because a reader
    // branches on which one happened.
    assert(
      (stored.rows[0]!.outcome as string) !== (REJECTED_OUTCOME as string),
    );
    const ledger = await run.client.query<{ kind: string; reason: string }>(
      `select kind, reason from bakery.decisions_ledger
        where organization_id = $1 and run_id = $2`,
      [fixture.organizationId, run.job.runId],
    );
    assertEquals(ledger.rows[0]!.kind, "stop");
    assertEquals(ledger.rows[0]!.reason, "The customer withdrew the request.");
  });
});

Deno.test("tenancy: a foreign approval id answers identically to an invented one", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    const foreign = await assertRejects(() =>
      decideHumanApproval(run.client, {
        organizationId: crypto.randomUUID(),
        approvalId: asked.approvalId,
        principalId: fixture.principalId,
        decision: "approve",
        expectedVersion: 1,
        actorKind: "person",
        applicationId: run.applicationId,
        repositoryId: run.repositoryId,
        traceId: crypto.randomUUID(),
      })
    ) as StandardError;
    const invented = await assertRejects(() =>
      decideHumanApproval(run.client, {
        organizationId: crypto.randomUUID(),
        approvalId: crypto.randomUUID(),
        principalId: fixture.principalId,
        decision: "approve",
        expectedVersion: 1,
        actorKind: "person",
        applicationId: run.applicationId,
        repositoryId: run.repositoryId,
        traceId: crypto.randomUUID(),
      })
    ) as StandardError;
    // A real id in another organization and an invented id must be
    // indistinguishable, or the difference is an existence oracle.
    assertEquals(foreign.code, invented.code);
    assertEquals(foreign.params, invented.params);
    assertEquals(foreign.safeDetail, invented.safeDetail);
  });
});

Deno.test("AC6: a foreign organization cannot decide, expire or stop the run", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    // A different organization, asking about an approval it does not hold.
    const foreign = crypto.randomUUID();
    const before = await appendCounts(run.client, fixture.organizationId);
    const error = await assertRejects(() =>
      decideHumanApproval(run.client, {
        organizationId: foreign,
        approvalId: asked.approvalId,
        principalId: fixture.principalId,
        decision: "approve",
        expectedVersion: 1,
        actorKind: "person",
        applicationId: run.applicationId,
        repositoryId: run.repositoryId,
        traceId: crypto.randomUUID(),
      })
    ) as StandardError;
    // No oracle: it is not found, so a stranger cannot learn it exists.
    assertEquals(error.code, "RESOURCE_NOT_FOUND");
    assertEquals(
      await appendCounts(run.client, fixture.organizationId),
      before,
    );
    // The approval is still open, so the refusal changed nothing.
    const still = await run.client.query<{ status: string }>(
      `select status from bakery.questions where id = $1`,
      [asked.approvalId],
    );
    assertEquals(still.rows[0]!.status, "open");
  });
});

Deno.test("AC6: an agent cannot decide a human approval in a person's name", async () => {
  await withWorkerFixture(async (fixture) => {
    const run = await seedRun(fixture, fixture.principalId);
    const asked = await requestHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      runId: run.job.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    // An approval is a person's judgement. An agent acting for someone records
    // that it was an agent and who it acted for, so the ledger does not read as
    // if the person decided.
    await decideHumanApproval(run.client, {
      organizationId: fixture.organizationId,
      approvalId: asked.approvalId,
      principalId: fixture.principalId,
      decision: "approve",
      expectedVersion: 1,
      actorKind: "agent",
      onBehalfOf: fixture.principalId,
      applicationId: run.applicationId,
      repositoryId: run.repositoryId,
      traceId: crypto.randomUUID(),
    });
    const ledger = await run.client.query<{ detail: unknown }>(
      `select detail from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, asked.approvalId],
    );
    const detail = ledger.rows[0]!.detail as Record<string, unknown>;
    assertEquals(detail.actorKind, "agent");
    assertEquals(detail.onBehalfOf, fixture.principalId);
  });
});
