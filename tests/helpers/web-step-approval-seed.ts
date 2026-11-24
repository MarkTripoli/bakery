import { readDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";
import { requestHumanApproval } from "../../apps/server/src/modules/work/human-approval-store.ts";
import type { PgTransactionClient } from "../../packages/persistence/src/postgres.ts";

/**
 * Asks the person behind a run's waiting step, as the database owner, for
 * `apps/web/tests/step-approval-real-api.spec.ts`. No server path raises a
 * `run_step` approval while a run is going (only the integration tests call
 * `requestHumanApproval`), and a workflow with an approval wait is refused at
 * admission, so this calls `requestHumanApproval` for a run that waits on the
 * named step. The decision route, the run's outcome and the page are the real
 * server. Prints one JSON line with the approval id.
 *
 * Usage: `web-step-approval-seed.ts <runId> <stepKey> <prompt>` against the
 * stack named by `DATABASE_URL` (the owner URL `compose-up.sh` writes).
 */
const [runId, stepKey, prompt] = Deno.args.map((value) => value.trim());
if (!runId || !stepKey || !prompt) {
  console.error(
    "web-step-approval-seed: usage: web-step-approval-seed.ts <runId> <stepKey> <prompt>",
  );
  Deno.exit(2);
}
const database = openPgDatabase(
  readDatabaseConfig(Deno.env.toObject(), "owner").url,
);
try {
  const client = database as unknown as PgTransactionClient;
  let waiting: { id: string } | undefined;
  for (let attempt = 0; attempt < 120 && !waiting; attempt += 1) {
    waiting = (await client.query<{ id: string }>(
      `select id from bakery.run_steps
        where run_id = $1 and step_key = $2 and status = 'waiting'`,
      [runId, stepKey],
    )).rows[0];
    if (!waiting) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (!waiting) throw new Error("WEB_STEP_APPROVAL_WAIT_REQUIRED");
  const run = (await client.query<
    {
      organizationId: string;
      taskId: string;
      conversationId: string;
      applicationId: string;
      repositoryId: string | null;
      ownerPrincipalId: string | null;
      requestedBy: string;
    }
  >(
    `select r.organization_id as "organizationId", t.id as "taskId",
            t.conversation_id as "conversationId",
            t.application_id as "applicationId",
            t.repository_id as "repositoryId",
            d.owner_principal_id as "ownerPrincipalId",
            r.requested_by as "requestedBy"
       from bakery.workflow_runs r
       join bakery.tasks t
         on t.organization_id = r.organization_id and t.id = r.task_id
       join bakery.workflow_versions v
         on v.organization_id = r.organization_id and v.id = r.workflow_version_id
       join bakery.workflow_definitions d
         on d.organization_id = v.organization_id and d.id = v.workflow_id
      where r.id = $1`,
    [runId],
  )).rows[0];
  if (!run) throw new Error("WEB_STEP_APPROVAL_RUN_REQUIRED");
  const asked = await requestHumanApproval(client, {
    organizationId: run.organizationId,
    runId,
    taskId: run.taskId,
    conversationId: run.conversationId,
    stepKey,
    prompt,
    audience: [run.requestedBy],
    ownerPrincipalId: run.ownerPrincipalId,
    applicationId: run.applicationId,
    repositoryId: run.repositoryId,
    traceId: crypto.randomUUID(),
  });
  console.log(JSON.stringify({ approvalId: asked.approvalId }));
} finally {
  await closePgDatabase(database);
}
