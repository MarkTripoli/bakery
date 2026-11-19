import { registeredWorker, workerRequest } from "./worker-execution.ts";
import { seedEligibleNonmodelJob } from "./worker-execution/nonmodel-job.ts";
import {
  claimAssignment,
  type withWorkerFixture,
} from "./worker-execution/scenarios.ts";
import {
  SESSION_CALL_PATH,
  SESSION_CREDENTIAL_HEADER,
  SESSION_TOOLS_PATH,
} from "../../apps/server/src/modules/execution/session-routes.ts";

/** The worker fixture the integration tests run in. */
export type AgentFixture = Parameters<
  Parameters<typeof withWorkerFixture>[0]
>[0];

/** The powers a person can grant an agent (#414, O52). */
export type Power = "decide" | "run_control" | "run_start";

/** Grants one power to a workflow, as a person, straight into the table. */
export async function grantPower(
  fixture: AgentFixture,
  workflowId: string,
  power: Power,
): Promise<string> {
  const row = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.agent_power_grants
       (organization_id, power, workflow_id, granted_by)
     values ($1, $2, $3, $4) returning id`,
    [fixture.organizationId, power, workflowId, fixture.principalId],
  );
  return row.rows[0].id;
}

/** Another seeded run in the same organization, for an agent to act on. */
export const seedOtherRun = (fixture: AgentFixture) =>
  seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );

/**
 * Claims the only job in the fixture, so the session runs under its workflow.
 * With `granted`, that workflow holds the power before the claim, which is when
 * the credential's scopes are minted. Returns the session's own run, the grant
 * (to revoke) and the two things an agent does: list tools and call one.
 */
export async function agentSession(
  fixture: AgentFixture,
  options: { granted: Power | null },
) {
  const worker = await registeredWorker(fixture, { slots: 1 });
  const own = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
  );
  const grantId = options.granted === null
    ? null
    : await grantPower(fixture, own.workflowId, options.granted);
  const assignment = await claimAssignment(fixture, worker) as unknown as {
    attemptId: string;
    sessionCredential: string;
  };
  const headers = { [SESSION_CREDENTIAL_HEADER]: assignment.sessionCredential };
  const call = (tool: string, args: Record<string, unknown>) =>
    workerRequest(
      fixture,
      worker.credential,
      SESSION_CALL_PATH.replace(":id", assignment.attemptId),
      { tool, arguments: args },
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
  return { own, grantId, call, tools, attemptId: assignment.attemptId };
}
