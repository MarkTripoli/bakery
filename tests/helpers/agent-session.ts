import {
  type JobSeed,
  registeredWorker,
  workerRequest,
} from "./worker-execution.ts";
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
export type Power =
  | "decide"
  | "run_control"
  | "run_start"
  | "steer"
  | "steer_reviewer"
  | "ask";

/** What a grant names besides its power: who an ask grant may ask, and when it ends. */
export type GrantOptions = {
  roleKey?: string;
  groupId?: string;
  expiresAt?: Date;
};

/** Grants one power to a workflow, as a person, straight into the table. */
export async function grantPower(
  fixture: AgentFixture,
  workflowId: string,
  power: Power,
  options: GrantOptions = {},
): Promise<string> {
  const row = await fixture.pgDatabase.query<{ id: string }>(
    `insert into bakery.agent_power_grants
       (organization_id, power, workflow_id, granted_by, role_key, group_id,
        expires_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      fixture.organizationId,
      power,
      workflowId,
      fixture.principalId,
      options.roleKey ?? null,
      options.groupId ?? null,
      options.expiresAt ?? null,
    ],
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
  options: { granted: Power | null; grant?: GrantOptions },
) {
  const worker = await registeredWorker(fixture, { slots: 1 });
  // The session's workflow must compile: an agent spawns by admitting a run of
  // it, and the plan compiler refuses the default fixture document.
  const own = await seedEligibleNonmodelJob(
    fixture.pgDatabase,
    fixture.organizationId,
    fixture.principalId,
    { compilable: true },
  );
  const grantId = options.granted === null
    ? null
    : await grantPower(fixture, own.workflowId, options.granted, options.grant);
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

/**
 * A run row copied from `ownRunId` onto the same task by default, or onto
 * another task or workflow version. A copy on the same task stands in for a
 * retry or a later run of the work the session belongs to.
 */
export async function copyRunTo(
  fixture: AgentFixture,
  ownRunId: string,
  target: {
    taskId?: string;
    workflowVersionId?: string;
    status?: string;
  } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.workflow_runs (
       id, organization_id, task_id, workflow_version_id, requested_by, status,
       snapshot, budget_limit_usd
     ) select $3, organization_id, coalesce($4::uuid, task_id),
              coalesce($5::uuid, workflow_version_id), requested_by, $6,
              snapshot, 0
         from bakery.workflow_runs
        where organization_id = $1 and id = $2`,
    [
      fixture.organizationId,
      ownRunId,
      id,
      target.taskId ?? null,
      target.workflowVersionId ?? null,
      target.status ?? "queued",
    ],
  );
  return id;
}

/** A task below `parent`, with its own conversation, as the job seeder makes one. */
export async function insertChildTask(
  fixture: AgentFixture,
  parent: JobSeed,
): Promise<{ taskId: string; conversationId: string }> {
  const conversationId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.conversations (
       id, organization_id, application_id, title, created_by, repository_id
     ) select $3, organization_id, application_id, 'child', created_by,
              repository_id
         from bakery.conversations
        where organization_id = $1 and id = $2`,
    [fixture.organizationId, parent.conversationId, conversationId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.tasks (
       id, organization_id, application_id, conversation_id, title, task_type,
       status, priority, created_by, repository_id, repository_profile_id,
       repository_profile_revision, repository_profile_digest, parent_task_id
     ) select $3, organization_id, application_id, $4, 'child', task_type,
              'draft', priority, created_by, repository_id,
              repository_profile_id, repository_profile_revision,
              repository_profile_digest, id
         from bakery.tasks
        where organization_id = $1 and id = $2`,
    [fixture.organizationId, parent.taskId, taskId, conversationId],
  );
  return { taskId, conversationId };
}

/** A second workflow with its own version, which no grant covers. */
export async function ungrantedWorkflowVersion(
  fixture: AgentFixture,
  from: { workflowId: string; workflowVersionId: string },
): Promise<{ workflowId: string; versionId: string }> {
  const workflowId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  await fixture.pgDatabase.query(
    `insert into bakery.workflow_definitions (id, organization_id, slug, name)
     select $3::uuid, organization_id, 'ungranted-' || gen_random_uuid()::text,
            'Ungranted'
       from bakery.workflow_definitions
      where organization_id = $1 and id = $2`,
    [fixture.organizationId, from.workflowId, workflowId],
  );
  await fixture.pgDatabase.query(
    `insert into bakery.workflow_versions (
       id, organization_id, workflow_id, revision, source_yaml, normalized_spec,
       digest, status, created_by
     ) select $3, organization_id, $4, 1, source_yaml, normalized_spec,
              digest || '-ungranted', status, created_by
         from bakery.workflow_versions
        where organization_id = $1 and id = $2`,
    [fixture.organizationId, from.workflowVersionId, versionId, workflowId],
  );
  return { workflowId, versionId };
}
