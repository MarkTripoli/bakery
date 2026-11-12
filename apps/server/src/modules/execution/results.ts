import { type Context } from "hono";
import {
  contractSchemas,
  workerActionOutputSchema,
} from "@bakery/contracts/contracts";
import { RepositoryInspectionReportSchema } from "@bakery/contracts/repository-inspection";
import { finalizeOrDenyQualityCheck } from "../delivery/finalize-quality-check.ts";
import {
  finalizeOrDenyReview,
  recordReviewJobFailure,
} from "../delivery/finalize-review.ts";
import { publishInspection } from "../projects/inspection-publication.ts";
import { jsonResponse, parseContract } from "./http.ts";
import { problemResponse, StandardError } from "@bakery/contracts/http";
import {
  assertActiveLease,
  compareExistingEvent,
  loadExistingEvent,
  lockAttempt,
  throwAttemptMutationAuthorityError,
  validateWorkerReferences,
} from "./events.ts";
import {
  assertAttemptMutationSession,
  assertCurrentWorkerSession,
  assertWorkerMutationSessionShape,
  type AttemptRow,
  canonicalJson,
  type ExecutionEventScope,
  type ExecutionRouteOptions,
  iso,
  jsonValue,
  parseIdempotencyKey,
  type PgTransactionClient,
  readAttemptId,
  type RequestMetadata,
  requestMetadata,
  sha256Hex,
  workerIdempotencyUuid,
  workerTransaction,
} from "./shared.ts";
import { settleWorkflowAction } from "../work/budget.ts";
import {
  emitExecutionEvent,
  EXECUTION_TELEMETRY_EVENTS,
  type JobOutcome,
} from "./telemetry.ts";
import { reconcileCoordinationForTerminalTask } from "../work/coordination-projection.ts";

import { appendAudit } from "@bakery/persistence/event-audit";
import { createResultsRepository } from "@bakery/persistence/results";
import { releaseCoordinatorJobReservation } from "@bakery/persistence";
import { COORDINATOR_TURN_ACTION } from "@bakery/contracts/coordinator-turn";
import {
  forceCloseOutputBinding,
  loadFinalizationGrant,
  recordFinalizationFailure,
  requeueRetryableAttemptFailure,
  withPgTransaction,
} from "@bakery/persistence";
import { finalizeOutputTranscript } from "./output-transcript.ts";

export async function renewLease(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const input = await parseContract(context, contractSchemas.LeaseRenewal);
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const leaseTokenHash = await sha256Hex(input.leaseToken);
  const requestDigest = await sha256Hex(canonicalJson({
    attemptId,
    fence: input.fence,
    leaseSeconds: input.leaseSeconds,
    leaseTokenHash,
  }));
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      assertWorkerMutationSessionShape(
        identity.host,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      const repository = createResultsRepository(transaction);
      const renewalOptions = {
        organizationId: identity.host.organization_id,
        attemptId,
        workerHostId: identity.host.id,
        idempotencyKey,
      };
      await repository.lockRenewal(renewalOptions);
      const replay = await repository.loadRenewalReplay(renewalOptions);
      const replayResponse = (row: {
        requestDigest: string;
        response: unknown;
      }) => {
        if (row.requestDigest !== requestDigest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        return {
          response: contractSchemas.LeaseState.parse(
            jsonValue(row.response, {}),
          ),
          replayed: true,
        };
      };
      const attempt = await lockAttempt(transaction, identity, attemptId);
      if (replay) {
        assertCurrentWorkerSession(
          identity.host,
          input.workerSessionId,
          input.workerSessionGeneration,
        );
        assertAttemptMutationSession(
          identity.host,
          attempt,
          input.workerSessionId,
          input.workerSessionGeneration,
        );
        return replayResponse(replay);
      }
      assertAttemptMutationSession(
        identity.host,
        attempt,
        input.workerSessionId,
        input.workerSessionGeneration,
      );
      assertActiveLease(
        attempt,
        identity,
        leaseTokenHash,
        input.fence,
      );
      const renewed = await repository.renewLease({
        organizationId: identity.host.organization_id,
        attemptId: attempt.id,
        workerHostId: identity.host.id,
        leaseTokenHash,
        fence: input.fence,
        leaseSeconds: input.leaseSeconds,
      });
      if (!renewed) {
        await throwAttemptMutationAuthorityError(
          transaction,
          identity,
          attempt.id,
          leaseTokenHash,
          input.fence,
        );
        throw new Error("LEASE_RENEWAL_FAILED");
      }
      const response = contractSchemas.LeaseState.parse({
        attemptId: attempt.id,
        fence: BigInt(attempt.fence).toString(),
        leaseExpiresAt: iso(renewed.leaseExpiresAt),
        status: "active",
        leaseDurationSeconds: input.leaseSeconds,
        serverTime: iso(renewed.serverTime),
      });
      await repository.saveRenewalReplay({
        organizationId: identity.host.organization_id,
        attemptId: attempt.id,
        workerHostId: identity.host.id,
        idempotencyKey,
        requestDigest,
        response,
      });
      return { response, replayed: false };
    },
  );
  // The renewal has committed. A replay renewed nothing, so it says nothing.
  if (!result.replayed) {
    emitExecutionEvent(
      options.telemetry,
      EXECUTION_TELEMETRY_EVENTS.leaseRenewed,
      {
        "bakery.attempt.id": attemptId,
      },
    );
  }
  return jsonResponse(result.response, 200, result.replayed);
}

/**
 * One coordinator turn is one model run: a worker fault is never retried, so
 * it is recorded non-retryable whatever the worker reported.
 */
function nonRetryableFault(fault: unknown): unknown {
  if (!fault || typeof fault !== "object" || Array.isArray(fault)) return fault;
  const { retryAfterSeconds: _after, ...rest } = fault as Record<
    string,
    unknown
  >;
  return { ...rest, retryable: false };
}

function resultEventType(status: "completed" | "failed" | "canceled"): string {
  return status === "completed"
    ? "job.succeeded"
    : status === "failed"
    ? "job.failed"
    : "job.cancelled";
}

type FinalizedRunStep = ExecutionEventScope & {
  readonly organizationId: string;
  readonly runId: string;
  readonly runStepId: string;
  readonly taskId: string;
  readonly jobId: string;
  readonly jobVersion: number;
  readonly attemptId: string;
  readonly stepVersion: number;
  readonly runVersion: number;
  readonly runStatus: string;
  readonly stepStatus: "completed" | "failed" | "canceled";
};

async function finalizeRunStep(
  transaction: PgTransactionClient,
  attempt: AttemptRow,
  status: "completed" | "failed" | "canceled",
  input: Record<string, unknown>,
  principalId: string,
  metadata: RequestMetadata,
): Promise<FinalizedRunStep> {
  const finalized = await createResultsRepository(transaction).finalizeRunStep({
    attempt: {
      id: attempt.id,
      organizationId: attempt.organization_id,
      jobId: attempt.job_id,
      workerHostId: attempt.worker_host_id,
      workerSessionId: attempt.worker_session_id,
      workerSessionGeneration: attempt.worker_session_generation,
      fence: attempt.fence,
      leaseTokenHash: attempt.lease_token_hash,
      leaseExpiresAt: attempt.lease_expires_at,
      leaseExpired: attempt.lease_expired,
      jobCurrentFence: attempt.job_current_fence,
      status: attempt.status,
      lastEventSeq: attempt.last_event_seq,
    },
    status,
    input,
    principalId,
    metadata,
  }) as FinalizedRunStep;
  // Same transaction, after the task terminal update (persistence cannot
  // import the server): keep the coordination plan/lane projection current.
  if (["completed", "failed", "canceled"].includes(finalized.runStatus)) {
    await reconcileCoordinationForTerminalTask(transaction, {
      organizationId: finalized.organizationId,
      taskId: finalized.taskId,
      traceId: metadata.traceId,
    });
  }
  return finalized;
}

export async function resultRoute(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const attemptId = readAttemptId(context);
  const resultInput = await parseContract(
    context,
    contractSchemas.WorkerResult,
  );
  const resultPayload = resultInput.status === "completed"
    ? resultInput.result
    : undefined;
  const faultPayload = resultInput.status === "failed"
    ? resultInput.fault
    : undefined;
  const cancellationPayload = resultInput.status === "canceled"
    ? resultInput.cancellation
    : undefined;
  const idempotencyKey = workerIdempotencyUuid(
    context.req.header("Idempotency-Key"),
  );
  const metadata = requestMetadata(context);
  let resultOrganizationId = "";
  // Set when the transaction settled usage, read only after it has committed. The
  // callback runs once per request and a denied inspection result returns before
  // the emit, so nothing that rolled back can reach it.
  let usageSettled = false;
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      resultOrganizationId = identity.host.organization_id;
      const inspectionJob = await transaction.query<{ action: string }>(
        `select j.action from bakery.jobs j
           join bakery.job_attempts a on a.organization_id = j.organization_id and a.job_id = j.id
          where a.organization_id = $1 and a.id = $2`,
        [identity.host.organization_id, attemptId],
      );
      const isInspection =
        inspectionJob.rows[0]?.action === "repository.inspect" ||
        RepositoryInspectionReportSchema.safeParse(resultPayload).success;
      if (isInspection) await transaction.query("savepoint inspection_result");
      try {
        const repository = createResultsRepository(transaction);
        assertWorkerMutationSessionShape(
          identity.host,
          resultInput.workerSessionId,
          resultInput.workerSessionGeneration,
        );
        const attempt = await lockAttempt(transaction, identity, attemptId);
        const eventType = resultEventType(resultInput.status);
        const leaseTokenHash = await sha256Hex(resultInput.leaseToken);
        const digest = await sha256Hex(canonicalJson({
          fence: resultInput.fence,
          leaseTokenHash,
          localSeq: resultInput.localSeq,
          status: resultInput.status,
          usage: resultInput.usage ?? null,
          result: resultPayload ?? null,
          fault: faultPayload ?? null,
          cancellation: cancellationPayload ?? null,
        }));
        const existing = await loadExistingEvent(
          transaction,
          identity.host.organization_id,
          attemptId,
          resultInput.localSeq,
        );
        if (existing) {
          if (isInspection) {
            assertAttemptMutationSession(
              identity.host,
              attempt,
              resultInput.workerSessionId,
              resultInput.workerSessionGeneration,
            );
            if (
              !resultInput.workerSessionId ||
              !resultInput.workerSessionGeneration ||
              attempt.lease_token_hash !== leaseTokenHash ||
              BigInt(attempt.fence) !== BigInt(resultInput.fence) ||
              BigInt(attempt.job_current_fence) !== BigInt(resultInput.fence)
            ) {
              throw new StandardError({ code: "LEASE_FENCED" });
            }
          }
          const ack = compareExistingEvent(
            existing,
            idempotencyKey,
            eventType,
            digest,
          );
          return { ack, replayed: true };
        }
        assertAttemptMutationSession(
          identity.host,
          attempt,
          resultInput.workerSessionId,
          resultInput.workerSessionGeneration,
        );
        if (
          attempt.status === "canceled" && resultInput.status === "completed"
        ) {
          const auditRowCount = await appendAudit(transaction, {
            organizationId: attempt.organization_id,
            principalId: identity.host.principal_id,
            operation: "workers.result",
            resourceType: "job_attempt",
            resourceId: attempt.id,
            requestId: metadata.requestId,
            traceId: metadata.traceId,
            outcome: "denied",
            details: {
              requested: "completed",
              observed: "canceled",
              code: "ALREADY_TERMINAL",
              httpStatus: 409,
            },
          });
          if (auditRowCount !== 1) {
            throw new Error("WORKER_RESULT_DENIAL_AUDIT_INSERT_FAILED");
          }
          return { denied: new StandardError({ code: "ALREADY_TERMINAL" }) };
        }
        if (["completed", "failed", "canceled"].includes(attempt.status)) {
          throw new StandardError({ code: "ALREADY_TERMINAL" });
        }
        if (
          isInspection &&
          (!resultInput.workerSessionId || !resultInput.workerSessionGeneration)
        ) {
          throw new StandardError({ code: "MALFORMED_REQUEST" });
        }
        assertActiveLease(
          attempt,
          identity,
          leaseTokenHash,
          resultInput.fence,
        );
        if (
          BigInt(resultInput.localSeq) !== BigInt(attempt.last_event_seq) + 1n
        ) {
          throw new StandardError({
            code: "EXPECTED_SEQUENCE",
            params: {
              expectedLocalSeq: (BigInt(attempt.last_event_seq) + 1n)
                .toString(),
              ackedLocalSeq: BigInt(attempt.last_event_seq).toString(),
            },
          });
        }
        const jobRow = await repository.loadResultJob(
          identity.host.organization_id,
          attempt.job_id,
        );
        if (!jobRow) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
        if (BigInt(jobRow.currentFence) !== BigInt(resultInput.fence)) {
          throw new StandardError({ code: "LEASE_FENCED" });
        }
        if (["completed", "failed", "canceled"].includes(jobRow.status)) {
          throw new StandardError({ code: "ALREADY_TERMINAL" });
        }
        if (jobRow.cancelRequestedAt && resultInput.status !== "canceled") {
          throw new StandardError({ code: "CANCEL_REQUESTED" });
        }
        if (resultInput.status === "completed") {
          if (jobRow.action === "repository.inspect") {
            await publishInspection(
              transaction,
              attempt,
              identity,
              resultPayload,
              metadata,
            );
          } else {
            const outputSchema = workerActionOutputSchema(jobRow.action);
            if (!outputSchema.safeParse(resultPayload).success) {
              throw new StandardError({ code: "VALIDATION_FAILED" });
            }
            // A check report is a claim until the server has recomputed every
            // identity and the verdict from its own pins. The rows it writes
            // are what validateWorkerReferences resolves below. A refused
            // report is returned, not thrown, so the denied audit entry that
            // names the failed comparison commits with the 422.
            if (jobRow.action === "quality.check") {
              const denial = await finalizeOrDenyQualityCheck(transaction, {
                attempt,
                identity,
                jobId: attempt.job_id,
                resultPayload,
                metadata,
              });
              if (denial) return { denied: denial };
            }
            // A review report is a claim too: the server verifies it against
            // its own pins, records the cycle and takes the delivery decision
            // here, so the rows a repair appends are in place before
            // finalizeRunStep rolls the run up. A refused report is returned,
            // not thrown, so its denied audit entry commits with the 422.
            if (jobRow.action === "review.independent") {
              const denial = await finalizeOrDenyReview(transaction, {
                attempt,
                identity,
                jobId: attempt.job_id,
                resultPayload,
                metadata,
              });
              if (denial) return { denied: denial };
            }
          }
        }
        const eventId = idempotencyKey;
        const ack = contractSchemas.WorkerAck.parse({
          eventId,
          status: "applied",
          lastEventSeq: resultInput.localSeq,
        });
        const coordinatorJob = jobRow.action === COORDINATOR_TURN_ACTION;
        if (resultInput.usage) {
          // A coordinator turn is subscription-funded and run-less: there is
          // no usage receipt to settle, so any submitted usage is refused.
          if (coordinatorJob) {
            throw new StandardError({
              code: "STATE_CONFLICT",
              params: { reason: "coordinator_usage_not_accepted" },
            });
          }
          if (
            !jobRow.installationReservationId ||
            !jobRow.runId ||
            !jobRow.runStepId
          ) {
            throw new StandardError({ code: "STATE_CONFLICT" });
          }
          if (
            !resultInput.workerSessionId ||
            !resultInput.workerSessionGeneration
          ) {
            throw new StandardError({ code: "MALFORMED_REQUEST" });
          }
          await settleWorkflowAction(transaction, {
            organizationId: attempt.organization_id,
            runId: jobRow.runId,
            runStepId: jobRow.runStepId,
            installationReservationId: jobRow.installationReservationId,
            attemptId: attempt.id,
            workerHostId: identity.host.id,
            workerSessionId: resultInput.workerSessionId,
            workerSessionGeneration: resultInput.workerSessionGeneration,
            fence: resultInput.fence,
            resultEventId: eventId,
            receipt: resultInput.usage,
          });
          usageSettled = true;
        }
        const payload = {
          localSeq: resultInput.localSeq,
          status: resultInput.status,
          ...(resultPayload === undefined ? {} : { result: resultPayload }),
          ...(faultPayload === undefined ? {} : {
            fault: coordinatorJob
              ? nonRetryableFault(faultPayload)
              : faultPayload,
          }),
          ...(cancellationPayload === undefined
            ? {}
            : { cancellation: cancellationPayload }),
        };
        await validateWorkerReferences(
          transaction,
          attempt,
          eventType,
          payload,
        );
        await repository.appendResultEvent({
          organizationId: attempt.organization_id,
          attemptId: attempt.id,
          localSeq: resultInput.localSeq,
          eventId,
          eventType,
          payload,
          payloadDigest: digest,
          savedAck: ack,
        });
        const attemptStatus = resultInput.status === "completed"
          ? "completed"
          : resultInput.status === "failed"
          ? "failed"
          : "canceled";
        const closeAttemptOutput = () =>
          forceCloseOutputBinding(transaction, {
            organizationId: attempt.organization_id,
            attemptId: attempt.id,
            jobId: attempt.job_id,
            workerHostId: attempt.worker_host_id,
            workerSessionId: attempt.worker_session_id,
            workerSessionGeneration: String(attempt.worker_session_generation),
            fence: String(attempt.fence),
          });
        // A retryable failure without usage may requeue the job below. Its
        // output stream then stays open so the next attempt opens a new
        // producer generation on it (the lost-lease path); a closed stream
        // cannot be reopened, so the retry would fail to bind its output.
        const mayRequeue = resultInput.status === "failed" &&
          faultPayload?.retryable === true && resultInput.usage === undefined;
        let transcriptGrantIds: string[] = mayRequeue
          ? []
          : await closeAttemptOutput();
        const attemptUpdated = await repository.finishAttempt({
          organizationId: attempt.organization_id,
          attemptId: attempt.id,
          workerHostId: identity.host.id,
          leaseTokenHash,
          fence: resultInput.fence,
          localSeq: resultInput.localSeq,
          payload,
          status: attemptStatus,
        });
        if (!attemptUpdated) {
          await throwAttemptMutationAuthorityError(
            transaction,
            identity,
            attempt.id,
            leaseTokenHash,
            resultInput.fence,
          );
        }
        // A retryable fault without usage requeues the job while attempts
        // remain. A failure with usage stays terminal: settleWorkflowAction
        // settled the budget intent, so a re-claim could not be funded.
        const retryQueued = mayRequeue &&
          await requeueRetryableAttemptFailure(transaction, {
            organizationId: attempt.organization_id,
            jobId: attempt.job_id,
            attemptId: attempt.id,
            fence: resultInput.fence,
            metadata,
          });
        if (retryQueued) {
          await appendAudit(transaction, {
            organizationId: attempt.organization_id,
            principalId: identity.host.principal_id,
            operation: "workers.result",
            resourceType: "job_attempt",
            resourceId: attempt.id,
            requestId: metadata.requestId,
            traceId: metadata.traceId,
            details: {
              jobId: attempt.job_id,
              status: resultInput.status,
              retryQueued: true,
            },
          });
          return { ack, replayed: false, grantIds: transcriptGrantIds };
        }
        if (mayRequeue) transcriptGrantIds = await closeAttemptOutput();
        const jobUpdated = await repository.finishJob({
          organizationId: attempt.organization_id,
          jobId: attempt.job_id,
          status: attemptStatus,
          fence: resultInput.fence,
        });
        if (!jobUpdated) {
          await throwAttemptMutationAuthorityError(
            transaction,
            identity,
            attempt.id,
            leaseTokenHash,
            resultInput.fence,
          );
        }
        if (coordinatorJob) {
          // Standalone job: no run step to finalize. Terminal job and the
          // released reservation commit together with the audit row.
          await releaseCoordinatorJobReservation(transaction, {
            organizationId: attempt.organization_id,
            jobId: attempt.job_id,
          });
          await appendAudit(transaction, {
            organizationId: attempt.organization_id,
            principalId: identity.host.principal_id,
            operation: "workers.result",
            resourceType: "job_attempt",
            resourceId: attempt.id,
            requestId: metadata.requestId,
            traceId: metadata.traceId,
            details: { jobId: attempt.job_id, status: resultInput.status },
          });
        } else if (jobRow.action === "repository.inspect") {
          await appendAudit(transaction, {
            organizationId: attempt.organization_id,
            principalId: identity.host.principal_id,
            operation: "workers.result",
            resourceType: "job_attempt",
            resourceId: attempt.id,
            requestId: metadata.requestId,
            traceId: metadata.traceId,
            details: { jobId: attempt.job_id, status: resultInput.status },
          });
        } else {
          // A review that failed for good stops the loop with a durable
          // decision. This point is past the requeue decision above, so a
          // retryable fault that was given another attempt never gets here.
          if (
            jobRow.action === "review.independent" &&
            resultInput.status === "failed"
          ) {
            await recordReviewJobFailure(transaction, {
              attempt,
              identity,
              jobId: attempt.job_id,
              faultCode: String(faultPayload?.code ?? ""),
              metadata,
            });
          }
          await finalizeRunStep(
            transaction,
            attempt,
            resultInput.status,
            resultInput as unknown as Record<string, unknown>,
            identity.host.principal_id,
            metadata,
          );
        }
        return { ack, replayed: false, grantIds: transcriptGrantIds };
      } catch (error) {
        if (!isInspection || !(error instanceof StandardError)) throw error;
        // Publication and terminal state roll back together. Returning the
        // denial commits this audit before the HTTP error is emitted.
        await transaction.query("rollback to savepoint inspection_result");
        const inserted = await appendAudit(transaction, {
          organizationId: identity.host.organization_id,
          principalId: identity.host.principal_id,
          operation: "repositoryObservations.publish",
          resourceType: "job_attempt",
          resourceId: attemptId,
          requestId: metadata.requestId,
          traceId: metadata.traceId,
          outcome: "denied",
          details: { code: error.code },
        });
        if (inserted !== 1) {
          throw new Error("INSPECTION_DENIAL_AUDIT_INSERT_FAILED");
        }
        return { denied: error };
      }
    },
  );
  if ("denied" in result) {
    return problemResponse(
      context,
      result.denied,
      {
        publicBaseUrl: options.publicBaseUrl,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
      },
    );
  }
  // The result has committed, whatever the grant finalization below does. A
  // replayed result changed nothing, so it says nothing.
  // A status the contract gains that the allowlist does not list would lose its
  // outcome silently; this assignment turns that into a compile error.
  const outcome: JobOutcome = resultInput.status;
  if (!result.replayed) {
    emitExecutionEvent(
      options.telemetry,
      EXECUTION_TELEMETRY_EVENTS.jobCompleted,
      {
        "bakery.attempt.id": attemptId,
        "bakery.outcome": outcome,
      },
    );
    if (usageSettled) {
      emitExecutionEvent(
        options.telemetry,
        EXECUTION_TELEMETRY_EVENTS.usageSettled,
        {
          "bakery.attempt.id": attemptId,
        },
      );
    }
  }
  for (
    const grantId of ("grantIds" in result ? result.grantIds : undefined) ?? []
  ) {
    try {
      await workerTransaction(
        options.database,
        context.req.raw.headers,
        async (transaction, identity) => {
          const grant = await loadFinalizationGrant(
            transaction,
            identity.host.organization_id,
            grantId,
          );
          if (!grant.payload_digest) return;
          await finalizeOutputTranscript(transaction, {
            organizationId: identity.host.organization_id,
            workerHostId: identity.host.id,
            workerPrincipalId: identity.host.principal_id,
            attemptId: grant.attempt_id,
          }, {
            grantId: grant.id,
            sessionId: grant.session_id,
            frozenHighwater: grant.frozen_highwater,
            payloadDigest: grant.payload_digest,
          });
        },
      );
    } catch (_error) {
      // The result is committed; the archive sweep retries this grant.
      await withPgTransaction(options.database, async (transaction) => {
        await recordFinalizationFailure(
          transaction,
          resultOrganizationId,
          grantId,
          true,
        );
      });
    }
  }
  return jsonResponse(result.ack, 200, result.replayed);
}
