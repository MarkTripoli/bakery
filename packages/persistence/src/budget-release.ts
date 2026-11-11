import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "./postgres.ts";

const REJECTION_OPERATION = "workers.claim.assignment_payload_rejected";
const REJECTION_CODE = "INVALID_ASSIGNMENT_PAYLOAD";

type EvidenceRow = {
  id: string;
  jobId: string;
  jobVersion: number | null;
  attemptId: string | null;
  effectId: string;
  sourceEventId: string | null;
  kind: "pre-dispatch-rejection";
  digest: string;
};

type RejectionState = {
  jobId: string;
  jobVersion: number;
  jobStatus: string;
  action: string;
  installationReservationId: string;
  reservationStatus: string;
  intentStatus: string;
  providerCallIntentId: string | null;
  providerCallStatus: string | null;
  providerCallId: string | null;
  attemptCount: string;
};

function conflict(reason: string): never {
  throw new StandardError({ code: "STATE_CONFLICT", params: { reason } });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function rejectionDigest(options: {
  organizationId: string;
  jobId: string;
  jobVersion: number;
  installationReservationId: string;
  effectId: string;
  sourceEventId: string;
}): Promise<string> {
  return sha256Hex(JSON.stringify([
    "budget-assignment-rejection-v1",
    REJECTION_CODE,
    options.organizationId,
    options.jobId,
    options.jobVersion,
    null,
    options.installationReservationId,
    options.effectId,
    options.sourceEventId,
  ]));
}

function sameEvidence(
  left: EvidenceRow,
  right: Omit<EvidenceRow, "id">,
): boolean {
  return left.jobId === right.jobId &&
    left.jobVersion === right.jobVersion &&
    left.attemptId === right.attemptId &&
    left.effectId === right.effectId &&
    left.sourceEventId === right.sourceEventId &&
    left.kind === right.kind &&
    left.digest === right.digest;
}

export async function persistAssignmentRejectionBudgetEvidence(
  transaction: PgTransactionClient,
  options: Readonly<{
    organizationId: string;
    jobId: string;
    jobVersion: number;
  }>,
): Promise<void> {
  if (!Number.isSafeInteger(options.jobVersion) || options.jobVersion < 1) {
    conflict("no_spend_evidence_job_version_invalid");
  }
  const job = await transaction.query<{
    jobId: string;
    jobVersion: number;
    jobStatus: string;
    action: string;
    installationReservationId: string | null;
  }>(
    `select id as "jobId", version as "jobVersion", status as "jobStatus",
            action, installation_reservation_id as "installationReservationId"
       from bakery.jobs
      where organization_id = $1 and id = $2
      for update`,
    [options.organizationId, options.jobId],
  );
  const jobRow = job.rows[0];
  if (!jobRow) conflict("no_spend_evidence_job_missing");
  if (
    jobRow.jobVersion !== options.jobVersion ||
    jobRow.jobStatus !== "failed"
  ) return;
  if (!jobRow.installationReservationId) return;

  // The claim transaction already owns the job. Lock its exact intent before
  // reservations/provider state, matching release and provider binding.
  const intent = await transaction.query<{ id: string }>(
    `select intent.id
       from bakery.jobs job
       join bakery.run_steps step
         on step.organization_id = job.organization_id
        and step.id = job.run_step_id
       join bakery.budget_action_intents intent
         on intent.organization_id = job.organization_id
        and intent.run_id = step.run_id
        and intent.run_step_id = job.run_step_id
        and intent.action = job.action
        and intent.agent_version_id = job.agent_version_id
        and intent.installation_reservation_id = job.installation_reservation_id
      where job.organization_id = $1 and job.id = $2
        and intent.status = 'held'
      order by intent.id
      for update of intent`,
    [options.organizationId, options.jobId],
  );
  if (intent.rows.length !== 1) return;

  const state = await transaction.query<RejectionState>(
    `select job.id as "jobId", job.version as "jobVersion", job.status as "jobStatus",
            job.action, reservation.status as "reservationStatus",
            intent.status as "intentStatus",
            intent.installation_reservation_id as "installationReservationId",
            intent.provider_call_intent_id as "providerCallIntentId",
            call.status as "providerCallStatus",
            call.provider_call_id as "providerCallId",
            (
              select count(*)::text
                from bakery.job_attempts attempt
               where attempt.organization_id = job.organization_id
                 and attempt.job_id = job.id
            ) as "attemptCount"
       from bakery.jobs job
       join bakery.budget_reservations reservation
         on reservation.organization_id = job.organization_id
        and reservation.id = job.installation_reservation_id
       join bakery.budget_action_intents intent
         on intent.organization_id = job.organization_id
        and intent.installation_reservation_id = reservation.id
       join bakery.provider_call_intents call
         on call.organization_id = intent.organization_id
        and call.id = intent.provider_call_intent_id
        and call.run_id = intent.run_id
        and call.run_step_id = intent.run_step_id
        and call.installation_reservation_id = intent.installation_reservation_id
      where job.organization_id = $1 and job.id = $2 and intent.id = $3
      for update of reservation, call`,
    [options.organizationId, options.jobId, intent.rows[0]!.id],
  );
  const stateRow = state.rows[0];
  if (!stateRow) return;
  if (
    stateRow.jobId !== options.jobId ||
    stateRow.jobVersion !== options.jobVersion ||
    stateRow.jobStatus !== "failed" ||
    stateRow.reservationStatus !== "held" ||
    stateRow.intentStatus !== "held" ||
    stateRow.providerCallIntentId === null ||
    stateRow.providerCallStatus !== "pending" ||
    stateRow.providerCallId !== null
  ) return;
  if (Number(stateRow.attemptCount) !== 0) return;

  const effectId =
    `budget-assignment-rejection:${options.jobId}:${options.jobVersion}`;
  const existing = await transaction.query<EvidenceRow>(
    `select id, job_id as "jobId", job_version as "jobVersion",
            attempt_id as "attemptId", effect_id as "effectId",
            source_event_id as "sourceEventId", kind, digest
       from bakery.budget_release_evidence
      where organization_id = $1 and installation_reservation_id = $2`,
    [options.organizationId, stateRow.installationReservationId],
  );
  const prior = existing.rows[0];
  if (prior) {
    if (
      prior.jobVersion === null || prior.sourceEventId === null ||
      prior.attemptId !== null || prior.effectId !== effectId
    ) conflict("no_spend_evidence_legacy");
    const audit = await transaction.query<{ id: string }>(
      `select id
         from bakery.audit_events
        where organization_id = $1 and id = $2
          and operation = $3
          and resource_type = 'job'
          and resource_id = $4
          and outcome = 'denied'
          and details->>'code' = $5
          and details->>'version' = $6
        limit 1`,
      [
        options.organizationId,
        prior.sourceEventId,
        REJECTION_OPERATION,
        options.jobId,
        REJECTION_CODE,
        String(options.jobVersion),
      ],
    );
    if (!audit.rows[0]) conflict("no_spend_evidence_source_missing");
    const digest = await rejectionDigest({
      organizationId: options.organizationId,
      jobId: options.jobId,
      jobVersion: options.jobVersion,
      installationReservationId: stateRow.installationReservationId,
      effectId,
      sourceEventId: prior.sourceEventId,
    });
    if (
      !sameEvidence(prior, {
        jobId: options.jobId,
        jobVersion: options.jobVersion,
        attemptId: null,
        effectId,
        sourceEventId: prior.sourceEventId,
        kind: "pre-dispatch-rejection",
        digest,
      })
    ) conflict("no_spend_evidence_conflict");
    return;
  }

  const audit = await transaction.query<{ id: string }>(
    `select id
       from bakery.audit_events
      where organization_id = $1
        and operation = $2
        and resource_type = 'job'
        and resource_id = $3
        and outcome = 'denied'
        and details->>'code' = $4
        and details->>'version' = $5
      order by created_at desc, id desc
      limit 1`,
    [
      options.organizationId,
      REJECTION_OPERATION,
      options.jobId,
      REJECTION_CODE,
      String(options.jobVersion),
    ],
  );
  const sourceEventId = audit.rows[0]?.id;
  if (!sourceEventId) conflict("no_spend_evidence_source_missing");
  const digest = await rejectionDigest({
    organizationId: options.organizationId,
    jobId: options.jobId,
    jobVersion: options.jobVersion,
    installationReservationId: stateRow.installationReservationId,
    effectId,
    sourceEventId,
  });
  await transaction.query(
    `insert into bakery.budget_release_evidence (
       organization_id, installation_reservation_id, job_id, job_version,
       attempt_id, effect_id, source_event_id, kind, digest, observed_at
     ) values ($1, $2, $3, $4, null, $5, $6, $7, $8, clock_timestamp())`,
    [
      options.organizationId,
      stateRow.installationReservationId,
      options.jobId,
      options.jobVersion,
      effectId,
      sourceEventId,
      "pre-dispatch-rejection",
      digest,
    ],
  );
}
