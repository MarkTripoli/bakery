import { assert, assertEquals } from "@std/assert";
import {
  registeredWorker,
  workerRequest,
} from "../helpers/worker-execution.ts";
import { seedEligibleNonmodelJob } from "../helpers/worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  withWorkerFixture,
} from "../helpers/worker-execution/scenarios.ts";
import {
  SESSION_CALL_PATH,
  SESSION_CREDENTIAL_HEADER,
  SESSION_TOOLS_PATH,
} from "../../apps/server/src/modules/execution/session-routes.ts";
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import type { PgTransactionClient } from "../../apps/server/src/platform/database.ts";

// #414 slice 1: an agent decides an approval only where a person granted the
// power to its workflow, never on its own run's output, and the decision is
// labelled as an agent's action. Driven through the real app and the session
// gateway, because each rule can hold below it and still be missing from the
// path an agent actually takes.

type Fixture = Parameters<Parameters<typeof withWorkerFixture>[0]>[0];

async function grant(
  fixture: Fixture,
  workflowId: string,
  power = "decide",
): Promise<string> {
  const row = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.agent_power_grants
       (organization_id, power, workflow_id, granted_by)
     values ($1, $2, $3, $4) returning id`,
    [fixture.organizationId, power, workflowId, fixture.principalId],
  );
  return row.rows[0].id;
}

/** An open step approval in the given run, addressed to the person. */
async function approvalIn(
  fixture: Fixture,
  run: {
    runId: string;
    taskId: string;
    conversationId: string;
    applicationId: string;
  },
): Promise<string> {
  const asked = await requestHumanApproval(
    fixture.pgDatabase as unknown as PgTransactionClient,
    {
      organizationId: fixture.organizationId,
      runId: run.runId,
      taskId: run.taskId,
      conversationId: run.conversationId,
      stepKey: "human.approval",
      prompt: "Ship it?",
      ownerPrincipalId: fixture.principalId,
      traceId: crypto.randomUUID(),
      applicationId: run.applicationId,
      repositoryId: null,
    },
  );
  return asked.approvalId;
}

/**
 * Claims the only job in the fixture, so the session runs under its workflow.
 * With `granted`, that workflow holds the decide power before the claim, which
 * is when the credential's scopes are minted.
 */
async function sessionFor(fixture: Fixture, options: { granted: boolean }) {
  const worker = await registeredWorker(fixture, { slots: 1 });
  const own = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const grantId = options.granted ? await grant(fixture, own.workflowId) : null;
  const assignment = await claimAssignment(fixture, worker) as unknown as {
    attemptId: string;
    sessionCredential: string;
  };
  const headers = {
    [SESSION_CREDENTIAL_HEADER]: assignment.sessionCredential,
  };
  const decide = (id: string) =>
    workerRequest(
      fixture,
      worker.credential,
      SESSION_CALL_PATH.replace(":id", assignment.attemptId),
      {
        tool: "approvals.decide",
        arguments: { id, decision: "approve", expectedVersion: 1 },
      },
      { headers },
    );
  const tools = async () => {
    const response = await workerRequest(
      fixture,
      worker.credential,
      SESSION_TOOLS_PATH.replace(":id", assignment.attemptId),
      undefined,
      { method: "GET", headers },
    );
    const body = await response.json() as { tools: { name: string }[] };
    return body.tools.map((tool) => tool.name);
  };
  return { own, grantId, decide, tools };
}

const otherRun = () => (fixture: Fixture) =>
  seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );

Deno.test("an agent decides another run's approval where its workflow is granted", () =>
  withWorkerFixture(async (fixture) => {
    const { decide, tools } = await sessionFor(fixture, { granted: true });
    assert((await tools()).includes("approvals.decide"));
    const approvalId = await approvalIn(fixture, await otherRun()(fixture));
    const response = await decide(approvalId);
    assertEquals(response.status, 200, await response.text());

    const ledger = await fixture.pgDatabase.query<{
      kind: string;
      decided_by: string;
      detail: { actorKind?: string; onBehalfOf?: string };
    }>(
      `select kind, decided_by, detail from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(ledger.rows.length, 1);
    // Attributed to the person, labelled as the agent's action (O50).
    assertEquals(ledger.rows[0].decided_by, fixture.principalId);
    assertEquals(ledger.rows[0].detail.actorKind, "agent");
    assertEquals(ledger.rows[0].detail.onBehalfOf, fixture.principalId);
  }));

Deno.test("without a grant the decision is not offered and not allowed", () =>
  withWorkerFixture(async (fixture) => {
    const { decide, tools } = await sessionFor(fixture, { granted: false });
    assert(!(await tools()).includes("approvals.decide"));
    const approvalId = await approvalIn(fixture, await otherRun()(fixture));
    const response = await decide(approvalId);
    assertEquals(response.status, 403, await response.text());
  }));

Deno.test("a revoked grant stops the next call", () =>
  withWorkerFixture(async (fixture) => {
    const { grantId, decide } = await sessionFor(fixture, { granted: true });
    const approvalId = await approvalIn(fixture, await otherRun()(fixture));
    await fixture.pgDatabase.query(
      `delete from bakery.agent_power_grants where id = $1`,
      [grantId],
    );
    // The scope was minted at claim, but the action rechecks the grant live.
    const response = await decide(approvalId);
    assertEquals(response.status, 403, await response.text());
  }));

Deno.test("an agent never decides the approval of its own run", () =>
  withWorkerFixture(async (fixture) => {
    const { own, decide } = await sessionFor(fixture, { granted: true });
    const approvalId = await approvalIn(fixture, own);
    const response = await decide(approvalId);
    assertEquals(response.status, 403, await response.text());
    // Refused before anything is written: the approval is still open and the
    // ledger holds no decision for it.
    const state = await fixture.pgDatabase.query<{ status: string }>(
      `select status from bakery.questions
        where organization_id = $1 and id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(state.rows[0].status, "open");
    const ledger = await fixture.pgDatabase.query(
      `select 1 from bakery.decisions_ledger
        where organization_id = $1 and subject_id = $2`,
      [fixture.organizationId, approvalId],
    );
    assertEquals(ledger.rows.length, 0);
  }));
