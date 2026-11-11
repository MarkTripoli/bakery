import { assertEquals } from "@std/assert";
import { appendDomainEvent, withPgTransaction } from "@bakery/persistence";
import { sha256Hex } from "../../../apps/server/src/platform/canonical-json.ts";
import type { WorkerFixture, WorkerRegistration } from "../worker-execution.ts";

/**
 * Arrange a PREEXISTING in-flight model attempt for post-admission protocol tests.
 * This is not a claim response or proof of fresh model/funding admission. Keep
 * the job's historical null billing/reservation fields; never fabricate holds.
 */
export async function seedLegacyLeasedModelAttempt(
  fixture: Pick<WorkerFixture, "pgDatabase" | "organizationId">,
  worker: { registration: WorkerRegistration },
  jobId: string,
) {
  const leaseToken = crypto.randomUUID();
  const fence = "1";
  return await withPgTransaction(fixture.pgDatabase, async (transaction) => {
    const context = await transaction.query<{
      applicationId: string;
      repositoryId: string | null;
      taskId: string;
      conversationId: string;
      action: string;
      billing: unknown;
      reservation: string | null;
    }>(
      `select task.application_id as "applicationId", task.repository_id as "repositoryId",
              task.id as "taskId", task.conversation_id as "conversationId",
              job.action, job.billing, job.installation_reservation_id as reservation
         from bakery.jobs job
         join bakery.run_steps step on step.organization_id = job.organization_id and step.id = job.run_step_id
         join bakery.workflow_runs run on run.organization_id = step.organization_id and run.id = step.run_id
         join bakery.tasks task on task.organization_id = run.organization_id and task.id = run.task_id
        where job.organization_id = $1 and job.id = $2
          and job.status = 'queued' and job.current_fence = 0
        for update of job`,
      [fixture.organizationId, jobId],
    );
    const scope = context.rows[0];
    if (!scope) throw new Error("LEGACY_ATTEMPT_FIXTURE_JOB_MISSING");
    assertEquals(scope.action, "harness.implement");
    assertEquals(scope.billing, null);
    assertEquals(scope.reservation, null);
    const attempt = await transaction.query<{ id: string }>(
      `insert into bakery.job_attempts (
         organization_id, job_id, worker_host_id, worker_session_id,
         worker_session_generation, attempt_no, fence, lease_token_hash,
         lease_expires_at, status
       ) select host.organization_id, $2, host.id, host.worker_session_id,
                host.worker_session_generation, 1, $3, $4,
                clock_timestamp() + interval '45 seconds', 'leased'
           from bakery.worker_hosts host
          where host.organization_id = $1 and host.id = $5
            and host.worker_session_id = $6 and host.worker_session_generation = $7
       returning id`,
      [
        fixture.organizationId,
        jobId,
        fence,
        await sha256Hex(leaseToken),
        worker.registration.workerHostId,
        worker.registration.workerSessionId,
        worker.registration.workerSessionGeneration,
      ],
    );
    const row = attempt.rows[0];
    if (!row) throw new Error("LEGACY_ATTEMPT_FIXTURE_HOST_MISSING");
    const updated = await transaction.query<{ version: number }>(
      `update bakery.jobs set status = 'leased', current_fence = $3,
              version = version + 1, updated_at = current_timestamp
        where organization_id = $1 and id = $2 returning version`,
      [fixture.organizationId, jobId, fence],
    );
    // Preserve the preexisting assignment event used by terminal wakeup checks.
    await appendDomainEvent(transaction, {
      organizationId: fixture.organizationId,
      applicationId: scope.applicationId,
      repositoryId: scope.repositoryId,
      taskId: scope.taskId,
      conversationId: scope.conversationId,
      eventType: "job.updated",
      aggregateId: jobId,
      aggregateVersion: updated.rows[0]!.version,
      payload: { jobId, attemptId: row.id, version: updated.rows[0]!.version },
      traceId: crypto.randomUUID(),
    });
    return {
      jobId,
      attemptId: row.id,
      workerHostId: worker.registration.workerHostId,
      leaseToken,
      fence,
    };
  });
}
