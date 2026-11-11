import { StandardError } from "@bakery/contracts/http";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  type ActiveIntegrationRegistry,
  type AuthoritySnapshotPort,
  authorizeInvocation,
  type BoundInvocation,
} from "../catalog/integration-gate.ts";
import { consumeApprovalForAdmission } from "../conversation/approvals.ts";
import { GATE_REFUSAL_CODES } from "../catalog/integration-provider-outcome.ts";
import { externalIdentityOf } from "./identity.ts";
import {
  latestApprovedRevisionId,
  lockApproval,
  lockReservationForPrepare,
  type RunScopeFacts,
  type StepJobFacts,
} from "./repository.ts";
import type { EffectFailureCode, ExternalEffectRow } from "./schema.ts";

/**
 * Admission checks of one effect claim. Each returns the failure code that
 * blocks the claim, or null when the check passes. Only errors that say
 * nothing about the effect itself (a transport failure while loading
 * authority, a SQL error) propagate, so the claim rolls back and the effect
 * stays `prepared`.
 */

const TERMINAL_STATUSES: readonly string[] = [
  "completed",
  "failed",
  "canceled",
  "blocked",
];
const TERMINAL_JOB_STATUSES: readonly string[] = [
  "completed",
  "failed",
  "canceled",
];

/** Run, step and job state: terminal run or step, a canceled job, or only terminal jobs block. */
export function runAdmission(
  run: RunScopeFacts | null,
  jobs: readonly StepJobFacts[],
): EffectFailureCode | null {
  if (run === null) return null;
  if (
    TERMINAL_STATUSES.includes(run.runStatus) ||
    TERMINAL_STATUSES.includes(run.stepStatus)
  ) return "run_terminal";
  if (jobs.some((j) => j.cancelRequested || j.status === "canceled")) {
    return "job_canceled";
  }
  if (
    jobs.length > 0 &&
    jobs.every((j) => TERMINAL_JOB_STATUSES.includes(j.status))
  ) {
    return "job_terminal";
  }
  return null;
}

/** The held, unexpired reservation of the effect's own run step must still back it. */
export async function reservationAdmission(
  tx: PgTransactionClient,
  effect: ExternalEffectRow,
): Promise<EffectFailureCode | null> {
  if (effect.budgetReservationId === null) return null;
  const reservation = await lockReservationForPrepare(
    tx,
    effect.organizationId,
    effect.budgetReservationId,
  );
  if (!reservation || reservation.status !== "held") {
    return "budget_reservation_not_held";
  }
  if (reservation.expired) return "budget_reservation_expired";
  if (
    reservation.runStepId === null ||
    reservation.runStepId !== effect.runStepId ||
    (reservation.externalEffectId !== null &&
      reservation.externalEffectId !== effect.id)
  ) return "budget_reservation_scope_mismatch";
  return null;
}

/** Identifiers a synthetic approval consume writes into its audit trail. */
export type ApprovalClaimContext = Readonly<{
  requestId: string;
  traceId: string;
}>;

/**
 * Approval state. The primary path is an approval the run already consumed at
 * admission: it must still bind the same stage and policy and still be the
 * task's newest approved plan revision, otherwise `approval_stale`. An
 * approval nobody consumed yet (reachable only for SQL-seeded approvals,
 * since plan admission consumes the one stage that exists) is consumed here
 * once, with the principal persisted at prepare. A retry claim never consumes.
 * The consume's zero-row refusal is a JS throw after a successful statement,
 * so the transaction is not aborted and no savepoint is needed.
 */
export async function approvalAdmission(
  tx: PgTransactionClient,
  effect: ExternalEffectRow,
  run: RunScopeFacts | null,
  context: ApprovalClaimContext,
): Promise<EffectFailureCode | null> {
  if (effect.approvalId === null) return null;
  if (run === null) return "approval_unavailable";
  const approval = await lockApproval(
    tx,
    effect.organizationId,
    effect.approvalId,
  );
  if (!approval || approval.revoked) return "approval_unavailable";
  const latest = await latestApprovedRevisionId(
    tx,
    effect.organizationId,
    run.taskId,
  );
  const sameGrant = approval.stage === effect.approvalStage &&
    approval.policyDigest === effect.approvalPolicyDigest;
  if (approval.status === "consumed") {
    if (approval.consumedByRunId !== run.runId || !sameGrant) {
      return "approval_unavailable";
    }
    return latest !== null && latest === approval.subjectId
      ? null
      : "approval_stale";
  }
  if (
    effect.dispatchGeneration > 0 || approval.status !== "answered" ||
    approval.decision !== "approve" || !sameGrant
  ) return "approval_unavailable";
  if (latest === null || latest !== approval.subjectId) return "approval_stale";
  try {
    await consumeApprovalForAdmission(tx, {
      organizationId: effect.organizationId,
      taskId: run.taskId,
      approvalId: effect.approvalId,
      runId: run.runId,
      stage: effect.approvalStage!,
      policyDigest: effect.approvalPolicyDigest!,
      principalId: effect.requestingPrincipalId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
  } catch (error) {
    if (
      error instanceof StandardError && error.code === "STATE_CONFLICT" &&
      error.params?.reason === "approval_unavailable"
    ) return "approval_unavailable";
    throw error;
  }
  return null;
}

export type AuthorityAdmission =
  | Readonly<{ ok: true; bound: BoundInvocation }>
  | Readonly<{ ok: false; failureCode: EffectFailureCode }>;

/**
 * Re-runs the gate against fresh authority with the persisted request, then
 * requires the install, the adapter manifest and the provider-side identity to
 * equal what prepare recorded. Only the gate's refusal codes block; any other
 * error (authority store unreachable, transient snapshot failure) propagates.
 */
export async function authorityAdmission(
  registry: ActiveIntegrationRegistry,
  snapshots: AuthoritySnapshotPort,
  effect: ExternalEffectRow,
): Promise<AuthorityAdmission> {
  const denied = { ok: false, failureCode: "authorization_denied" } as const;
  if (
    effect.integrationConnectionId === null ||
    effect.integrationResourceId === null ||
    effect.actionVersion === null ||
    effect.integrationInstallId === null ||
    effect.adapterManifestDigest === null
  ) return denied;
  let bound: BoundInvocation;
  try {
    bound = await authorizeInvocation(
      registry,
      snapshots,
      {
        organizationId: effect.organizationId,
        actorRef: effect.actorRef,
        connectionId: effect.integrationConnectionId,
        effectId: effect.id,
      },
      {
        actionId: effect.operation,
        actionVersion: effect.actionVersion,
        resourceId: effect.integrationResourceId,
        arguments: effect.safeArguments,
      },
    );
  } catch (error) {
    if (
      error instanceof StandardError && GATE_REFUSAL_CODES.includes(error.code)
    ) return denied;
    // Anything else (a transient snapshot-port failure) says nothing about the
    // grant: rethrow so the claim rolls back and the effect stays prepared.
    throw error;
  }
  if (bound.installId !== effect.integrationInstallId) {
    return { ok: false, failureCode: "integration_reinstalled" };
  }
  if (bound.manifestDigest !== effect.adapterManifestDigest) {
    return { ok: false, failureCode: "adapter_changed" };
  }
  let identity;
  try {
    identity = externalIdentityOf(registry, bound);
  } catch (error) {
    if (error instanceof StandardError) {
      return { ok: false, failureCode: "resource_identity_changed" };
    }
    throw error;
  }
  if (
    identity.account !== effect.externalAccountId ||
    identity.resource !== effect.externalResourceId
  ) return { ok: false, failureCode: "resource_identity_changed" };
  return { ok: true, bound };
}
