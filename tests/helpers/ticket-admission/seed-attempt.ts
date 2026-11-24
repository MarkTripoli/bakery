/**
 * A live job attempt on a worker host for a run's first step, as the worker
 * would hold it.
 *
 * The fixed-coding preset is a compiled plan, and a plan run has no step rows at
 * admission - the engine appends each one as the plan decides it
 * (`run-command.ts` inserts steps only for a non-plan run). So the first step is
 * materialised the way production materialises it, with one engine tick under an
 * owner, instead of being assumed to exist.
 *
 * There is exactly one route to that row, in one place, for every fixture that
 * needs a live attempt: this file. If the engine does not append the step this
 * fails; there is deliberately no hand-written fallback, because a fallback
 * would hide a broken engine behind a passing test.
 *
 * The owner is held for one synchronous tick and released on every exit path.
 * Nothing here asserts on lease state, so the pause tests do not gain lease
 * timing as a flake source. If the release is ever missed, the symptom lands on
 * the NEXT case as an owner error, not on this one.
 */
import { assertExists } from "@std/assert";
import { readPlanHost } from "../../../apps/server/src/modules/delivery/plan-host.ts";
import { createBakeryPostgresWorkflowRepository } from "../../../apps/server/src/modules/workflow-adapter/bakery-postgres-store.ts";
import { presetBudgetPolicy } from "../fixed-coding-preset.ts";
import type { TicketFixture } from "./fixtures.ts";

export async function seedAttempt(
  fx: TicketFixture,
  runId: string,
  adapterCapabilities: string[],
  /** Names the worker in the fixture's own terms, e.g. "Pause test worker". */
  label: string,
) {
  const ids = {
    principal: crypto.randomUUID(),
    host: crypto.randomUUID(),
    attempt: crypto.randomUUID(),
    session: crypto.randomUUID(),
  };
  const org = fx.organizationId;
  const engine = createBakeryPostgresWorkflowRepository({
    database: fx.runtime,
    maxAttempts: 3,
    budgetPolicy: presetBudgetPolicy,
    planHost: readPlanHost,
  });
  const owner = await engine.acquireEngineOwner(
    runId,
    crypto.randomUUID(),
    600_000,
  );
  assertExists(owner, "the run is not open to an engine owner");
  let engineJobId: string | null = null;
  try {
    const next = await engine.findNext(runId, owner);
    assertExists(next, "the plan asks for no first step");
    engineJobId = (await engine.admit(next, owner)).jobId ?? null;
  } finally {
    await engine.releaseEngineOwner(owner);
  }
  const step = await fx.owner.query<{ id: string }>(
    `select id from bakery.run_steps where organization_id = $1 and run_id = $2
      order by position, iteration limit 1`,
    [org, runId],
  );
  assertExists(step.rows[0], "the engine appended no first step");
  // The engine's own job for that step, not a second one beside it: the pause
  // path reads the run's live attempt, and two jobs on one step would make
  // which one is live a matter of luck.
  assertExists(engineJobId, "the engine appended the first step with no job");
  const jobId = engineJobId;
  await fx.owner.query(
    `update bakery.jobs set status = 'running', current_fence = 1
      where organization_id = $1 and id = $2`,
    [org, jobId],
  );
  await fx.owner.query(
    `insert into bakery.principals (id, display_name, principal_type)
     values ($1, $2, 'worker')`,
    [ids.principal, label],
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
    [ids.attempt, org, jobId, ids.host, ids.session, `lease-${ids.attempt}`],
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
    await fx.owner.query("delete from bakery.jobs where id = $1", [jobId]);
    await fx.owner.query("delete from bakery.worker_hosts where id = $1", [
      ids.host,
    ]);
    await fx.owner.query("delete from bakery.principals where id = $1", [
      ids.principal,
    ]);
  };
  return { commands, cleanup, hostId: ids.host, attemptId: ids.attempt };
}
