import { assert, assertEquals } from "@std/assert";
import {
  decideHumanApproval,
  requestHumanApproval,
} from "../../apps/server/src/modules/work/human-approval-store.ts";
import {
  canonicalJson,
  sha256Hex,
} from "../../apps/server/src/platform/canonical-json.ts";
import { StandardError } from "../../packages/contracts/src/http.ts";
import { assertRejects } from "@std/assert";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";
import { openApprovalFixture } from "../helpers/scoped-approvals.ts";

/**
 * The route is what a person actually uses, so it is what these tests drive.
 *
 * The store tests cover the decision's own rules; these cover the seam between
 * the store and the HTTP response, which is where a step approval went wrong
 * before: the row was decided and then could not be projected, so a caller saw a
 * failure for a decision that had been recorded.
 */

/** Seed a run step and an approval on it, returning the ids the route needs. */
async function seedStepApproval(
  fixture: Awaited<ReturnType<typeof openApprovalFixture>>,
  approverPrincipalId: string,
) {
  const task = await fixture.newTask();
  // A real run through the real route, so the seed is not a hand-built row that
  // a schema change turns into a false failure. Its snapshot, requested_by and
  // profile are whatever admission itself writes.
  const started = await fixture.startRun(task.taskId);
  if (started.status !== 201) {
    throw new Error(`run failed ${started.status}: ${await started.text()}`);
  }
  const run = await started.json() as { id: string };
  const asked = await requestHumanApproval(
    fixture.fx.ownerPg as unknown as PgTransactionClient,
    {
      organizationId: fixture.fx.organizationId,
      runId: run.id,
      taskId: task.taskId,
      conversationId: task.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: approverPrincipalId,
      traceId: crypto.randomUUID(),
      applicationId: (
        await fixture.fx.owner<{ application_id: string }[]>`
          select application_id from bakery.tasks
           where organization_id = ${fixture.fx.organizationId}
             and id = ${task.taskId}`
      )[0].application_id,
      repositoryId: null,
    },
  );
  return { ...asked, task, runId: run.id };
}

Deno.test("AC6: the owner decides a step approval through the real route", async () => {
  const fixture = await openApprovalFixture();
  try {
    const asked = await seedStepApproval(fixture, fixture.fx.admin.principalId);
    const decided = await fixture.decide(
      { id: asked.approvalId, version: 1 },
      "approve",
      { identity: await fixture.as(fixture.fx.admin) },
    );
    assertEquals(decided.status, 200);
    const body = await decided.json();
    // The response is a well-formed approval, not just a 200: the row the route
    // writes has to be projectable back to the caller.
    assertEquals(body.status, "answered");
    assertEquals(body.decision, "approve");
    assertEquals(body.subjectType, "run_step");
    assertEquals(body.decidedBy, fixture.fx.admin.principalId);

    // And the decision is recorded where a reader looks for it.
    const ledger = await fixture.fx.owner<
      { kind: string; decided_by: string }[]
    >`
      select kind, decided_by from bakery.decisions_ledger
       where organization_id = ${fixture.fx.organizationId}
         and subject_id = ${asked.approvalId}`;
    assertEquals(ledger.length, 1);
    // The ledger uses the decision's own word, so a reader filters on the same
    // vocabulary the approver saw rather than translating between two.
    assertEquals(ledger[0].kind, "approval");
    assertEquals(ledger[0].decided_by, fixture.fx.admin.principalId);
  } finally {
    await fixture.close();
  }
});

Deno.test("AC6: a stranger cannot decide a step approval through the route", async () => {
  const fixture = await openApprovalFixture();
  try {
    const asked = await seedStepApproval(fixture, fixture.fx.admin.principalId);
    const before = (
      await fixture.fx.owner<{ n: string }[]>`
        select count(*)::text as n from bakery.decisions_ledger
         where organization_id = ${fixture.fx.organizationId}`
    )[0].n;

    const stranger = await fixture.decide(
      { id: asked.approvalId, version: 1 },
      "approve",
      { identity: await fixture.as(fixture.fx.developer) },
    );
    // No oracle: the approval does not exist for someone it was not addressed to.
    assertEquals(stranger.status, 404);

    const after = (
      await fixture.fx.owner<{ n: string }[]>`
        select count(*)::text as n from bakery.decisions_ledger
         where organization_id = ${fixture.fx.organizationId}`
    )[0].n;
    assertEquals(after, before);
    const still = await fixture.fx.owner<{ status: string }[]>`
      select status from bakery.questions where id = ${asked.approvalId}`;
    assertEquals(still[0].status, "open");
  } finally {
    await fixture.close();
  }
});

Deno.test("AC6: a replay through the route is a conflict, not a second decision", async () => {
  const fixture = await openApprovalFixture();
  try {
    const asked = await seedStepApproval(fixture, fixture.fx.admin.principalId);
    const first = await fixture.decide(
      { id: asked.approvalId, version: 1 },
      "approve",
      { identity: await fixture.as(fixture.fx.admin) },
    );
    assertEquals(first.status, 200);

    // Asking again with the version the caller still holds: the second attempt
    // must not record a second decision, and must say what happened.
    const replay = await fixture.decide(
      { id: asked.approvalId, version: 1 },
      "reject",
      { identity: await fixture.as(fixture.fx.admin) },
    );
    assert(replay.status === 409, `expected 409, got ${replay.status}`);
    const ledger = await fixture.fx.owner<{ n: string }[]>`
      select count(*)::text as n from bakery.decisions_ledger
       where organization_id = ${fixture.fx.organizationId}
         and subject_id = ${asked.approvalId}`;
    assertEquals(ledger[0].n, "1");
    const still = await fixture.fx.owner<{ decision: string }[]>`
      select decision from bakery.questions where id = ${asked.approvalId}`;
    assertEquals(still[0].decision, "approve");
  } finally {
    await fixture.close();
  }
});

Deno.test("AC6: a row that cannot be projected is refused before anything is written", async () => {
  const fixture = await openApprovalFixture();
  try {
    const asked = await seedStepApproval(fixture, fixture.fx.admin.principalId);
    // A row whose digests were never written cannot be answered in the response
    // shape the contract declares. Simulating that is the only way to reach the
    // pre-write projection: a freshly requested approval always projects.
    await fixture.fx.owner`
      update bakery.questions set subject_digest = null
       where id = ${asked.approvalId}`;

    const response = await fixture.decide(
      { id: asked.approvalId, version: 1 },
      "approve",
      { identity: await fixture.as(fixture.fx.admin) },
    );
    assert(
      response.status !== 200,
      `a row that cannot be projected must not answer 200, got ${response.status}`,
    );

    // The point of projecting before the write: a row that cannot be answered
    // must not end up decided. Otherwise the caller gets an error and the
    // approval is silently gone from the queue.
    const ledger = await fixture.fx.owner<{ n: string }[]>`
      select count(*)::text as n from bakery.decisions_ledger
       where organization_id = ${fixture.fx.organizationId}
         and subject_id = ${asked.approvalId}`;
    assertEquals(ledger[0].n, "0");
    const still = await fixture.fx.owner<{ status: string }[]>`
      select status from bakery.questions where id = ${asked.approvalId}`;
    assertEquals(still[0].status, "open");
  } finally {
    await fixture.close();
  }
});

Deno.test("AC6: the store refuses a stranger itself, not just the route", async () => {
  const fixture = await openApprovalFixture();
  try {
    const asked = await seedStepApproval(fixture, fixture.fx.admin.principalId);
    // Called straight at the writer with no route in front of it. The store is
    // the thing that writes the decision, so it has to enforce who may answer;
    // a check that lives only in the route is one new caller away from a hole.
    const client = fixture.fx.ownerPg as unknown as PgTransactionClient;
    const applicationId = (
      await fixture.fx.owner<{ application_id: string }[]>`
        select application_id from bakery.tasks
         where organization_id = ${fixture.fx.organizationId}`
    )[0].application_id;
    await assertRejects(
      () =>
        decideHumanApproval(client, {
          organizationId: fixture.fx.organizationId,
          approvalId: asked.approvalId,
          principalId: fixture.fx.developer.principalId,
          decision: "approve",
          expectedVersion: 1,
          actorKind: "person",
          traceId: crypto.randomUUID(),
          applicationId,
          repositoryId: null,
        }),
      StandardError,
    );
    const still = await fixture.fx.owner<{ status: string }[]>`
      select status from bakery.questions where id = ${asked.approvalId}`;
    assertEquals(still[0].status, "open");
  } finally {
    await fixture.close();
  }
});

Deno.test("AC6: the digests name this step, this prompt and these approvers", async () => {
  const fixture = await openApprovalFixture();
  try {
    const asked = await seedStepApproval(fixture, fixture.fx.admin.principalId);
    const row = (
      await fixture.fx.owner<
        { subject_digest: string; policy_digest: string }[]
      >`
        select subject_digest, policy_digest from bakery.questions
         where id = ${asked.approvalId}`
    )[0];
    // Both are real digests, not placeholders: a puzzle-box string that no
    // reader can recompute would satisfy the contract and prove nothing.
    for (const digest of [row.subject_digest, row.policy_digest]) {
      assert(/^[a-f0-9]{64}$/.test(digest), `not a sha256 digest: ${digest}`);
    }
    // They answer different questions, so they must not be the same value.
    assert(
      row.subject_digest !== row.policy_digest,
      "subject and policy digests must not coincide",
    );

    // Reproducible from what the approval says it is: the run, the step and the
    // prompt. A digest nobody can recompute is a decoration, not a binding.
    assertEquals(
      row.subject_digest,
      await sha256Hex(canonicalJson({
        runId: asked.runId,
        stepKey: "human.approval",
        prompt: "Ship it?",
      })),
    );
    assertEquals(
      row.policy_digest,
      await sha256Hex(canonicalJson({
        stepKey: "human.approval",
        approverPrincipalIds: [fixture.fx.admin.principalId],
      })),
    );
  } finally {
    await fixture.close();
  }
});
