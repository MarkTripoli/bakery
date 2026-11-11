import { readDatabaseConfig } from "../../packages/config/src/env.ts";
import {
  closePgDatabase,
  openPgDatabase,
} from "../../apps/server/src/platform/database.ts";

/**
 * Attaches a live worker attempt to a run the server already admitted, as the
 * database owner, for `apps/web/tests/task-run-control-real-api.spec.ts`. The
 * isolated test stack runs no enrolled worker, so the run's first job would
 * otherwise sit queued with no attempt and the run controls would answer
 * `no_active_attempt`. This seeds the worker host (with the given advertised
 * adapter capabilities), a live attempt on the run's first job, and marks the
 * job running. It seeds server state only: no process executes the attempt, so
 * control commands the server admits stay queued for a worker that is absent.
 * Prints one JSON line with the ids.
 *
 * Usage: `web-run-attempt-seed.ts <runId> <capabilitiesJson>` against the stack
 * named by `DATABASE_URL` (the owner URL `compose-up.sh` writes).
 */
const runId = Deno.args[0]?.trim();
const capabilitiesJson = Deno.args[1]?.trim();
if (!runId || !capabilitiesJson) {
  console.error(
    "web-run-attempt-seed: usage: web-run-attempt-seed.ts <runId> <capabilitiesJson>",
  );
  Deno.exit(2);
}
const capabilities: unknown = JSON.parse(capabilitiesJson);
if (
  !Array.isArray(capabilities) ||
  !capabilities.every((item) => typeof item === "string")
) {
  console.error("web-run-attempt-seed: capabilities must be a string array");
  Deno.exit(2);
}
const database = openPgDatabase(
  readDatabaseConfig(Deno.env.toObject(), "owner").url,
);
try {
  const found = await database.query<
    { organizationId: string; stepId: string; jobId: string }
  >(
    `select run.organization_id as "organizationId", step.id as "stepId", job.id as "jobId"
       from bakery.workflow_runs run
       join bakery.run_steps step
         on step.organization_id = run.organization_id and step.run_id = run.id
       join bakery.jobs job
         on job.organization_id = step.organization_id and job.run_step_id = step.id
      where run.id = $1
      order by step.position asc, step.iteration asc, job.created_at asc
      limit 1`,
    [runId],
  );
  const target = found.rows[0];
  if (!target) throw new Error("WEB_RUN_ATTEMPT_JOB_REQUIRED");
  const ids = {
    workerPrincipalId: crypto.randomUUID(),
    hostId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
  };
  await database.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, 'Control proof worker', 'worker')`,
    [ids.workerPrincipalId],
  );
  await database.query(
    `insert into bakery.worker_hosts (id, organization_id, principal_id, principal_type, name,
       os, architecture, capabilities, slots, credential_hash, worker_session_id,
       worker_session_generation, adapter_capabilities)
     values ($1, $2, $3, 'worker', 'Control proof host', 'linux', 'x64', '[]', 1, $4, $5, 0, $6::jsonb)`,
    [
      ids.hostId,
      target.organizationId,
      ids.workerPrincipalId,
      `control-${ids.hostId}`,
      ids.sessionId,
      JSON.stringify(capabilities),
    ],
  );
  await database.query(
    `update bakery.jobs set status = 'running', current_fence = 1
      where organization_id = $1 and id = $2`,
    [target.organizationId, target.jobId],
  );
  await database.query(
    `insert into bakery.job_attempts (id, organization_id, job_id, worker_host_id,
       worker_session_id, worker_session_generation, attempt_no, fence, lease_token_hash,
       lease_expires_at, status, started_at)
     values ($1, $2, $3, $4, $5, 0, 1, 1, $6, clock_timestamp() + interval '30 minutes', 'running', clock_timestamp())`,
    [
      ids.attemptId,
      target.organizationId,
      target.jobId,
      ids.hostId,
      ids.sessionId,
      `lease-${ids.attemptId}`,
    ],
  );
  console.log(JSON.stringify({ ...ids, jobId: target.jobId }));
} finally {
  await closePgDatabase(database);
}
