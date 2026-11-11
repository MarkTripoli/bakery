import type { PgTransactionClient } from "./postgres.ts";
import { StandardError } from "@bakery/contracts/http";
import { jobAssignmentPayloadSchema } from "@bakery/contracts/contracts";
import { admitRepositoryExecutionJob } from "./repository-admission.ts";
import {
  admitCoordinatorTurnJob,
  hasHeldCoordinatorTurnReservation,
} from "./coordinator-jobs.ts";
import { COORDINATOR_TURN_ACTION } from "@bakery/contracts/coordinator-turn";
import {
  connectivityState,
  type DispatchGate,
  dispatchGate,
} from "./machine-readiness.ts";
import { appendAudit, appendDomainEvent } from "./event-audit.ts";
import { executionActionCapabilities } from "./action-admission.ts";
import { hasHeldJobBudgetReservation } from "./budget-admission.ts";
import {
  markJobAssignmentPayloadInvalid,
  markJobAttemptBudgetExhausted,
  rebindLiveClaimAttempt,
  reclaimExpiredAttempts,
} from "./attempts.ts";
import {
  type RequestMetadata,
  sessionGeneration,
  type WorkerIdentity,
} from "./types.ts";

import {
  DEFAULT_LEASE_SECONDS,
  IDEMPOTENCY_REPLAY_TTL_SECONDS,
  RECLAIM_CLAIM_BATCH_SIZE,
} from "./constants.ts";
import {
  prepareIdentityOperation as prepareIdentityOperationInternal,
  type PrepareIdentityOperationInput,
  rebindPreparedIdentityOperation as rebindPreparedIdentityOperationInternal,
} from "./secret-identity.ts";
import type { SealedCredentialOperation } from "@bakery/contracts/secret-identity";
export {
  DEFAULT_LEASE_SECONDS,
  IDEMPOTENCY_REPLAY_TTL_SECONDS,
  RECLAIM_CLAIM_BATCH_SIZE,
} from "./constants.ts";

export type ClaimHost = {
  readonly id: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly capabilities: unknown;
  readonly slots: number;
  readonly status: string;
  readonly desiredMode: string;
  readonly protocolVersion: number;
  readonly credentialGeneration: number;
  readonly inventoryRevision: number;
  readonly workerSessionId: string | null;
  readonly workerSessionGeneration: string | number;
};

export type ClaimIdentity = { readonly host: ClaimHost };

const MAX_INVALID_ASSIGNMENTS_PER_CLAIM = 64;

const assignmentPayloadFields = new Set([
  "action",
  "requirements",
  "input",
  "currentCheckpoints",
  "agentConfig",
  "skillRefs",
  "agentVersionId",
  "billing",
  "installationReservationId",
]);

export type ClaimableJob = {
  id: string;
  action: string;
  requirements: unknown;
  input: unknown;
  currentCheckpoints: unknown;
  agentConfig: unknown;
  skillRefs: unknown;
  agentVersionId: string | null;
  billing: unknown;
  installationReservationId: string | null;
  /** Oldest server-created harness session for the job's run step, if any. */
  agentSessionId: string | null;
  currentFence: string | number;
};

export type ClaimReplay = {
  requestDigest: string;
  responseStatus: number;
  responseCiphertext: string | null;
  attemptId: string | null;
};

export type ClaimFailureReason =
  | "job_version_missing"
  | "attempt_insert_failed"
  | "attempt_budget_exhausted";
export type ClaimLease =
  | {
    ok: true;
    expiresAt: Date;
    serverTime: Date;
    attemptId: string;
    jobVersion: number;
  }
  | { ok: false; reason: ClaimFailureReason };

export type ClaimsRepository = {
  acquireClaimLock(workerHostId: string, claimKey: string): Promise<void>;
  readinessGate(): Promise<DispatchGate>;
  loadReplay(
    workerHostId: string,
    claimKey: string,
  ): Promise<ClaimReplay | null>;
  rebindLiveAttempt(attemptId: string | null | undefined): Promise<boolean>;
  rebindPreparedIdentityOperation(
    attemptId: string,
    authorityTime?: Date,
  ): Promise<void>;
  reclaimAndCountCapacity(options: {
    organizationId: string;
    workerHostId: string;
    principalId: string | null;
    metadata: RequestMetadata;
  }): Promise<bigint>;
  findClaimableJob(options: {
    organizationId: string;
    requestedCapabilities: readonly string[];
    supportedActions: readonly string[] | undefined;
    metadata: RequestMetadata;
    principalId: string | null;
  }): Promise<ClaimableJob | null>;
  nextAttemptNumber(jobId: string): Promise<number | undefined>;
  createLeasedAttempt(options: {
    organizationId: string;
    jobId: string;
    workerHostId: string;
    workerSessionId: string | null;
    workerSessionGeneration: string | number;
    attemptNo: number;
    fence: bigint;
    leaseToken: string;
    metadata: RequestMetadata;
  }): Promise<ClaimLease>;
  prepareIdentityOperation(
    input: PrepareIdentityOperationInput,
  ): Promise<SealedCredentialOperation>;
  recordAssignment(options: {
    organizationId: string;
    workerHostId: string;
    claimKey: string;
    requestDigest: string;
    jobId: string;
    attemptId: string;
    jobVersion: number;
    principalId: string | null;
    requestId: string;
    traceId: string;
    fence: bigint;
    encryptReplay: () => Promise<string>;
  }): Promise<void>;
  saveNoAssignmentReplay(options: {
    organizationId: string;
    workerHostId: string;
    claimKey: string;
    requestDigest: string;
  }): Promise<void>;
};

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function claimHostFromRow(host: WorkerIdentity["host"]): ClaimHost {
  return {
    id: host.id,
    organizationId: host.organizationId,
    principalId: host.principalId,
    capabilities: host.capabilities,
    slots: host.slots,
    status: host.status,
    desiredMode: host.desiredMode,
    protocolVersion: host.protocolVersion,
    credentialGeneration: host.credentialGeneration,
    inventoryRevision: host.inventoryRevision,
    workerSessionId: host.workerSessionId,
    workerSessionGeneration: host.workerSessionGeneration,
  };
}

export function createClaimsRepository(
  transaction: PgTransactionClient,
  identity: WorkerIdentity,
): ClaimsRepository {
  return {
    async readinessGate() {
      // The heartbeat stores the database clock (clock_timestamp()) as the
      // receipt time, so the gate judges connectivity against the same clock.
      const clock = await transaction.query<{ now: Date }>(
        "select clock_timestamp() as now",
      );
      const now = clock.rows[0]?.now;
      if (!now) throw new Error("WORKER_CLAIM_TIME_MISSING");
      const rows = await transaction.query<{
        check_id: string;
        status: string;
        reason: string | null;
        host_generation: number;
        inventory_revision: number;
        expires_at: Date | string;
      }>(
        `select check_id, status, reason, host_generation, inventory_revision,
                expires_at
         from bakery.worker_checks
         where worker_host_id = $1
         order by check_id asc, id asc`,
        [identity.host.id],
      );
      return dispatchGate({
        now,
        connectivity: connectivityState(identity.host.lastHeartbeatAt, now),
        status: identity.host.status,
        desiredMode: identity.host.desiredMode,
        credentialGeneration: identity.host.credentialGeneration,
        inventoryRevision: identity.host.inventoryRevision,
        checks: rows.rows.map((row) => ({
          checkId: row.check_id,
          componentKey: null,
          status: row.status,
          reason: row.reason,
          hostGeneration: row.host_generation,
          inventoryRevision: row.inventory_revision,
          expiresAt: row.expires_at,
        })),
      });
    },
    async acquireClaimLock(workerHostId, claimKey) {
      await transaction.query(
        `select pg_advisory_xact_lock(hashtextextended($1::text, 0))`,
        [`worker-claim:${workerHostId}:${claimKey}`],
      );
    },
    async loadReplay(workerHostId, claimKey) {
      await transaction.query(
        `delete from bakery.worker_claim_replays
         where worker_host_id = $1 and claim_key = $2
           and expires_at <= clock_timestamp()`,
        [workerHostId, claimKey],
      );
      const replay = await transaction.query<{
        request_digest: string;
        response_status: number;
        response_ciphertext: string | null;
        attempt_id: string | null;
      }>(
        `select request_digest, response_status, response_ciphertext, attempt_id
       from bakery.worker_claim_replays
       where worker_host_id = $1 and claim_key = $2
         and expires_at > clock_timestamp()`,
        [workerHostId, claimKey],
      );
      const row = replay.rows[0];
      if (!row) return null;
      return {
        requestDigest: row.request_digest,
        responseStatus: row.response_status,
        responseCiphertext: row.response_ciphertext,
        attemptId: row.attempt_id,
      };
    },
    async rebindLiveAttempt(attemptId) {
      return await rebindLiveClaimAttempt(transaction, identity, attemptId);
    },
    async rebindPreparedIdentityOperation(attemptId, authorityTime) {
      await rebindPreparedIdentityOperationInternal(
        transaction,
        identity,
        attemptId,
        authorityTime,
      );
    },
    async reclaimAndCountCapacity({
      organizationId,
      workerHostId,
      principalId,
      metadata,
    }) {
      await reclaimExpiredAttempts(
        transaction,
        organizationId,
        metadata,
        principalId,
        RECLAIM_CLAIM_BATCH_SIZE,
      );
      const capacity = await transaction.query<{ active: string }>(
        `select count(*)::text as active
       from bakery.job_attempts
       where organization_id = $1 and worker_host_id = $2
         and status in ('leased', 'running', 'canceling')
         and lease_expires_at > clock_timestamp()`,
        [organizationId, workerHostId],
      );
      return BigInt(capacity.rows[0]?.active ?? "0");
    },
    async findClaimableJob({
      organizationId,
      requestedCapabilities,
      supportedActions,
      metadata,
      principalId,
    }) {
      const enrolled = Array.isArray(identity.host.capabilities)
        ? identity.host.capabilities.filter((value): value is string =>
          typeof value === "string"
        )
        : [];
      const authenticatedCapabilities = requestedCapabilities.filter((
        capability,
      ) => enrolled.includes(capability));
      // A forward-only cursor keeps one finite queue snapshot. Each row gets
      // its own savepoint so a durable rejection is never batch-rolled back.
      await transaction.query(
        `declare claim_candidates no scroll cursor for
       select id, action, requirements, input,
          current_checkpoints, agent_config, skill_refs, agent_version_id,
          billing, installation_reservation_id, current_fence,
          (
            select session.id
              from bakery.agent_sessions session
             where session.organization_id = jobs.organization_id
               and session.run_step_id = jobs.run_step_id
             order by session.created_at asc, session.id asc
             limit 1
          ) as agent_session_id
       from bakery.jobs as jobs
       where organization_id = $1 and status = 'queued'
         and available_at <= clock_timestamp()
         and (
           (jobs.run_step_id is not null and jobs.action <> 'repository.inspect')
           or (
             jobs.run_step_id is null and jobs.action = 'coordinator.turn'
             and jobs.conversation_turn_id is not null
             and exists (
               select 1 from bakery.conversation_turns candidate_turn
                where candidate_turn.organization_id = jobs.organization_id
                  and candidate_turn.id = jobs.conversation_turn_id
                  and candidate_turn.status = 'active'
             )
           )
           or (
             jobs.run_step_id is null and jobs.action = 'repository.inspect'
             and exists (
               select 1 from bakery.repository_onboardings onboarding
                where onboarding.organization_id = jobs.organization_id
                  and onboarding.application_id = jobs.application_id
                  and onboarding.repository_id = jobs.repository_id
                  and onboarding.job_id = jobs.id
                  and onboarding.input = jobs.input
             )
           )
         )
         and (
           select count(*)
             from bakery.job_attempts attempt
            where attempt.organization_id = jobs.organization_id
              and attempt.job_id = jobs.id
              and attempt.status not in ('leased', 'running', 'canceling')
         ) < jobs.max_attempts
         and not exists (
           select 1
             from bakery.job_attempts live_attempt
            where live_attempt.organization_id = jobs.organization_id
              and live_attempt.job_id = jobs.id
              and live_attempt.status in ('leased', 'running', 'canceling')
              and live_attempt.lease_expires_at > clock_timestamp()
         )
         and (
           jobs.run_step_id is null
           or exists (
             select 1
               from bakery.run_steps candidate_step
               join bakery.workflow_runs candidate_run
                 on candidate_run.organization_id = candidate_step.organization_id
                and candidate_run.id = candidate_step.run_id
               join bakery.tasks candidate_task
                 on candidate_task.organization_id = candidate_run.organization_id
                and candidate_task.id = candidate_run.task_id
              where candidate_step.organization_id = jobs.organization_id
                and candidate_step.id = jobs.run_step_id
                and candidate_run.status not in
                  ('completed', 'failed', 'canceled', 'blocked')
                and candidate_step.status not in
                  ('completed', 'failed', 'canceled', 'blocked')
                and candidate_task.status not in ('completed', 'failed', 'canceled')
                and candidate_task.current_run_id = candidate_run.id
           )
         )
         and ($3::text[] is null or action = any($3::text[]))
         and (
           case
             when jsonb_typeof(requirements) = 'array' then requirements
             when jsonb_typeof(requirements) = 'object' then
               coalesce(requirements->'capabilities', '[]'::jsonb)
             else '[]'::jsonb
           end
         ) <@ $2::jsonb
         and (requirements->>'platform' is null or requirements->>'platform' = $4::text)
       order by priority desc, available_at asc, id asc
       for update skip locked`,
        [
          organizationId,
          JSON.stringify(authenticatedCapabilities),
          supportedActions,
          identity.host.os,
        ],
      );
      // Bound durable writes and retained locks without starving valid work
      // behind temporarily ineligible rows, whose savepoints are rolled back.
      let invalidCandidates = 0;
      while (invalidCandidates < MAX_INVALID_ASSIGNMENTS_PER_CLAIM) {
        await transaction.query("savepoint claim_candidate");
        const jobs = await transaction.query<{
          id: string;
          action: string;
          requirements: unknown;
          input: unknown;
          current_checkpoints: unknown;
          agent_config: unknown;
          skill_refs: unknown;
          agent_version_id: string | null;
          billing: unknown;
          installation_reservation_id: string | null;
          current_fence: string | number;
          agent_session_id: string | null;
        }>("fetch forward 1 from claim_candidates");
        const row = jobs.rows[0];
        if (!row) {
          await transaction.query("rollback to savepoint claim_candidate");
          await transaction.query("release savepoint claim_candidate");
          break;
        }
        if (row.action !== "repository.inspect") {
          try {
            const requirements = row.action === COORDINATOR_TURN_ACTION
              ? await admitCoordinatorTurnJob(
                transaction,
                organizationId,
                row.id,
              )
              : await admitRepositoryExecutionJob(
                transaction,
                organizationId,
                row.id,
              );
            if (
              requirements.capabilities.some((capability) =>
                !authenticatedCapabilities.includes(capability)
              ) ||
              ("platform" in requirements &&
                requirements.platform !== undefined &&
                requirements.platform !== identity.host.os)
            ) {
              await transaction.query("rollback to savepoint claim_candidate");
              await transaction.query("release savepoint claim_candidate");
              continue;
            }
          } catch (error) {
            if (
              error instanceof StandardError && error.code === "STATE_CONFLICT"
            ) {
              if (
                error.params?.reason === "agent_action_capability_denied" ||
                error.params?.reason === "model_agent_required" ||
                error.params?.reason === "model_billing_required"
              ) {
                const rejected = await markJobAssignmentPayloadInvalid(
                  transaction,
                  {
                    organizationId,
                    jobId: row.id,
                    currentFence: row.current_fence,
                    metadata,
                    principalId,
                    invalidFields: [
                      error.params.reason === "model_agent_required"
                        ? "agentVersionId"
                        : error.params.reason === "model_billing_required"
                        ? "billing"
                        : "agentConfig",
                    ],
                  },
                );
                if (rejected) {
                  invalidCandidates++;
                } else {
                  await transaction.query(
                    "rollback to savepoint claim_candidate",
                  );
                }
                await transaction.query("release savepoint claim_candidate");
                continue;
              }
              await transaction.query("rollback to savepoint claim_candidate");
              await transaction.query("release savepoint claim_candidate");
              continue;
            }
            throw error;
          }
        }
        const payload = {
          action: row.action,
          requirements: row.requirements,
          input: row.input,
          currentCheckpoints: row.current_checkpoints,
          agentConfig: row.agent_config,
          skillRefs: row.skill_refs,
          agentVersionId: row.agent_version_id,
          billing: row.billing,
          installationReservationId: row.installation_reservation_id,
        };
        const parsed = jobAssignmentPayloadSchema.safeParse(payload);
        const unfunded = parsed.success &&
          executionActionCapabilities(row.action).includes("model") &&
          !await (row.action === COORDINATOR_TURN_ACTION
            ? hasHeldCoordinatorTurnReservation(transaction, {
              organizationId,
              jobId: row.id,
            })
            : hasHeldJobBudgetReservation(transaction, organizationId, row.id));
        if (!parsed.success || unfunded) {
          const invalidFields = parsed.success
            ? ["installationReservationId"]
            : parsed.error.issues
              .map((issue) => issue.path[0])
              .filter((field): field is string =>
                typeof field === "string" && assignmentPayloadFields.has(field)
              );
          const rejected = await markJobAssignmentPayloadInvalid(transaction, {
            organizationId,
            jobId: row.id,
            currentFence: row.current_fence,
            metadata,
            principalId,
            invalidFields,
          });
          if (rejected) {
            invalidCandidates++;
          } else {
            await transaction.query("rollback to savepoint claim_candidate");
          }
          await transaction.query("release savepoint claim_candidate");
          continue;
        }
        await transaction.query("release savepoint claim_candidate");
        await transaction.query("close claim_candidates");
        return {
          id: row.id,
          action: row.action,
          requirements: row.requirements,
          input: row.input,
          currentCheckpoints: row.current_checkpoints,
          agentConfig: row.agent_config,
          skillRefs: row.skill_refs,
          agentVersionId: row.agent_version_id,
          billing: row.billing,
          installationReservationId: row.installation_reservation_id,
          agentSessionId: row.agent_session_id,
          currentFence: row.current_fence,
        };
      }
      await transaction.query("close claim_candidates");
      return null;
    },
    async nextAttemptNumber(jobId) {
      const result = await transaction.query<{ attempt_no: number }>(
        `select coalesce(max(attempt_no), 0) + 1 as attempt_no
       from bakery.job_attempts where job_id = $1`,
        [jobId],
      );
      return result.rows[0]?.attempt_no;
    },
    async createLeasedAttempt(options) {
      const budget = await transaction.query<{
        max_attempts: number;
        terminal_attempt_count: string;
        installation_reservation_id: string | null;
      }>(
        `select job.max_attempts,
                (
                  select count(*)::text
                    from bakery.job_attempts attempt
                   where attempt.organization_id = job.organization_id
                     and attempt.job_id = job.id
                     and attempt.status not in ('leased', 'running', 'canceling')
                ) as terminal_attempt_count,
                job.installation_reservation_id
           from bakery.jobs job
          where job.organization_id = $1 and job.id = $2
          for update`,
        [options.organizationId, options.jobId],
      );
      const budgetRow = budget.rows[0];
      if (!budgetRow) return { ok: false, reason: "job_version_missing" };
      if (Number(budgetRow.terminal_attempt_count) >= budgetRow.max_attempts) {
        await markJobAttemptBudgetExhausted(
          transaction,
          options.organizationId,
          options.jobId,
          null,
          options.metadata,
        );
        return { ok: false, reason: "attempt_budget_exhausted" };
      }
      const timing = await transaction.query<{
        expires_at: Date;
        server_time: Date;
      }>(
        `select clock_timestamp() as server_time,
           clock_timestamp() + ($1::integer * interval '1 second') as expires_at`,
        [DEFAULT_LEASE_SECONDS],
      );
      const timingRow = timing.rows[0];
      if (!timingRow) throw new Error("WORKER_LEASE_TIMING_MISSING");
      const attempt = await transaction.query<{ id: string }>(
        `insert into bakery.job_attempts (
         organization_id, job_id, worker_host_id,
         worker_session_id, worker_session_generation,
         attempt_no, fence, lease_token_hash, lease_expires_at, status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'leased')
       returning id`,
        [
          options.organizationId,
          options.jobId,
          options.workerHostId,
          options.workerSessionId,
          sessionGeneration(options.workerSessionGeneration, 1n).toString(),
          options.attemptNo,
          options.fence.toString(),
          await sha256Hex(options.leaseToken),
          timingRow.expires_at,
        ],
      );
      const jobUpdate = await transaction.query<{ version: number }>(
        `update bakery.jobs
       set status = 'leased', current_fence = $3,
           updated_at = current_timestamp, version = version + 1
       where organization_id = $1 and id = $2
       returning version`,
        [options.organizationId, options.jobId, options.fence.toString()],
      );
      const jobRow = jobUpdate.rows[0];
      if (!jobRow) return { ok: false, reason: "job_version_missing" };
      const attemptRow = attempt.rows[0];
      if (!attemptRow) return { ok: false, reason: "attempt_insert_failed" };
      // Dispatch binding (16-recovery-and-failures.md): the claim stamps the
      // action intent's provider-call intent with the leased attempt's
      // durable attribution, so budget recovery can settle a bound
      // authoritative receipt even when terminal usage publication is lost.
      // Re-claiming a requeued job re-stamps the current authority.
      if (budgetRow.installation_reservation_id) {
        await transaction.query(
          `update bakery.provider_call_intents call
              set attempt_id = $2,
                  worker_host_id = $3,
                  worker_session_id = $4,
                  worker_session_generation = $5,
                  attempt_fence = $6,
                  updated_at = now(), version = version + 1
             where call.id = (
                 select intent.provider_call_intent_id
                   from bakery.budget_action_intents intent
                  where intent.installation_reservation_id = $1
               )
               and call.attempt_id is distinct from $2`,
          [
            budgetRow.installation_reservation_id,
            attemptRow.id,
            options.workerHostId,
            options.workerSessionId,
            sessionGeneration(options.workerSessionGeneration, 1n).toString(),
            options.fence.toString(),
          ],
        );
      }
      return {
        ok: true,
        expiresAt: timingRow.expires_at,
        serverTime: timingRow.server_time,
        attemptId: attemptRow.id,
        jobVersion: jobRow.version,
      };
    },
    async prepareIdentityOperation(input) {
      return await prepareIdentityOperationInternal(transaction, input);
    },
    async recordAssignment(options) {
      const scope = await transaction.query<{
        applicationId: string;
        repositoryId: string | null;
        taskId: string;
        conversationId: string;
      }>(
        `select task.application_id as "applicationId",
                task.repository_id as "repositoryId",
                task.id as "taskId", task.conversation_id as "conversationId"
           from bakery.jobs job
           join bakery.run_steps step
             on step.organization_id = job.organization_id
            and step.id = job.run_step_id
           join bakery.workflow_runs run
             on run.organization_id = step.organization_id
            and run.id = step.run_id
           join bakery.tasks task
             on task.organization_id = run.organization_id
            and task.id = run.task_id
          where job.organization_id = $1 and job.id = $2`,
        [options.organizationId, options.jobId],
      );
      const scopeRow = scope.rows[0];
      await appendDomainEvent(transaction, {
        organizationId: options.organizationId,
        ...(scopeRow
          ? {
            applicationId: scopeRow.applicationId,
            repositoryId: scopeRow.repositoryId,
            taskId: scopeRow.taskId,
            conversationId: scopeRow.conversationId,
          }
          : {}),
        eventType: "job.updated",
        aggregateId: options.jobId,
        aggregateVersion: options.jobVersion,
        payload: {
          jobId: options.jobId,
          attemptId: options.attemptId,
          version: options.jobVersion,
        },
        traceId: options.traceId,
      });
      await appendAudit(transaction, {
        organizationId: options.organizationId,
        principalId: options.principalId,
        operation: "workers.claim",
        resourceType: "job_attempt",
        resourceId: options.attemptId,
        requestId: options.requestId,
        traceId: options.traceId,
        details: { jobId: options.jobId, fence: options.fence.toString() },
      });
      const responseCiphertext = await options.encryptReplay();
      await transaction.query(
        `insert into bakery.worker_claim_replays (
         organization_id, worker_host_id, claim_key, request_digest,
         response_status, response_ciphertext, attempt_id, expires_at
       ) values ($1, $2, $3, $4, 200, $5, $6,
         clock_timestamp() + ($7::integer * interval '1 second'))`,
        [
          options.organizationId,
          options.workerHostId,
          options.claimKey,
          options.requestDigest,
          responseCiphertext,
          options.attemptId,
          IDEMPOTENCY_REPLAY_TTL_SECONDS,
        ],
      );
    },
    async saveNoAssignmentReplay(options) {
      await transaction.query(
        `insert into bakery.worker_claim_replays (
           organization_id, worker_host_id, claim_key, request_digest,
           response_status, expires_at
         ) values ($1, $2, $3, $4, 204,
           clock_timestamp() + ($5::integer * interval '1 second'))`,
        [
          options.organizationId,
          options.workerHostId,
          options.claimKey,
          options.requestDigest,
          IDEMPOTENCY_REPLAY_TTL_SECONDS,
        ],
      );
    },
  };
}

export function claimIdentity(identity: WorkerIdentity): ClaimIdentity {
  return { host: claimHostFromRow(identity.host) };
}
