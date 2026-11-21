import { type Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import {
  contractSchemas,
  organizationId as asOrganizationId,
  principalId as asPrincipalId,
} from "@bakery/contracts/contracts";
import type { PgTransactionClient } from "@bakery/persistence";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { jsonBodyResponse, parseContract } from "./http.ts";
import { authorize } from "../auth/application/authorize.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import { redactContextText } from "../knowledge/context-redaction.ts";
import {
  type ExecutionRouteOptions,
  parseIdempotencyKey,
  requestDigest,
  requestMetadata,
  workerTransaction,
} from "./shared.ts";
import {
  ACTIVE_ATTEMPT_STATUSES,
  isMutating,
  OPERATION_COLUMNS,
  type OperationRow,
  projection,
  TERMINAL_PHASES,
} from "./maintenance.ts";

/**
 * Remote maintenance delivery (issue #25, slice B1): the heartbeat hands
 * operations to the host under a per-host fence, and the worker reports the
 * phases it reaches over POST /v1/worker/maintenance/{operationId}/reports.
 *
 * The host row is locked FOR UPDATE by the worker identity load for every
 * worker request, so assignment, fencing and phase moves for one host are
 * serialized with the claim path and with Admin maintenance requests.
 */

/** At most this many assignments travel in one heartbeat response. */
export const MAX_MAINTENANCE_ASSIGNMENTS = 20;
/** How long an assigned operation may run before its outcome is unknown. */
const EXECUTION_DEADLINE_SECONDS = 30 * 60;
/** Phases the host is working on; it keeps receiving these until done. */
const DELIVERED_PHASES = ["assigned", "applying", "reconciling"];
/** Phases a worker report may move from, and where each may go. */
const REPORT_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  assigned: ["applying", "reconciling", "succeeded", "failed", "rolled_back"],
  applying: ["applying", "reconciling", "succeeded", "failed", "rolled_back"],
  reconciling: ["reconciling", "succeeded", "failed", "rolled_back"],
};

type Host = {
  id: string;
  organizationId: string;
  principalId: string;
  status: string;
  desiredMode: string;
  credentialGeneration: number;
};

type ReportInput = {
  fence: string;
  sequence: number;
  phase: string;
  installedDigest?: string;
  installedVersion?: string;
  reason?: string;
  diagnostic?: string;
};

async function appendEvent(
  transaction: PgTransactionClient,
  row: OperationRow,
  organizationId: string,
  traceId: string,
): Promise<void> {
  await appendDomainEvent(transaction, {
    organizationId,
    eventType: "worker.maintenance_updated",
    aggregateId: row.id,
    aggregateVersion: row.version,
    workerHostId: row.worker_host_id,
    payload: { resourceId: row.id, resourceVersion: row.version },
    traceId,
  });
}

async function appendAuditRow(
  transaction: PgTransactionClient,
  host: Host,
  operation: "worker.heartbeat" | "worker.reportMaintenance",
  row: OperationRow,
  metadata: { requestId: string; traceId: string },
): Promise<void> {
  await transaction.query(
    `insert into bakery.audit_events (
       organization_id, principal_id, operation, resource_type,
       resource_id, outcome, request_id, trace_id, details
     ) values ($1, $2, $3, 'worker_maintenance_operation', $4,
       'succeeded', $5, $6, $7::jsonb)`,
    [
      host.organizationId,
      host.principalId,
      operation,
      row.id,
      metadata.requestId,
      metadata.traceId,
      JSON.stringify({
        workerHostId: row.worker_host_id,
        verb: row.verb,
        phase: row.phase,
        ...(reasonOf(row.result) ? { reason: reasonOf(row.result) } : {}),
      }),
    ],
  );
}

function reasonOf(result: unknown): string | undefined {
  if (result && typeof result === "object" && "reason" in result) {
    const reason = (result as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason : undefined;
  }
  return undefined;
}

/** Moves one operation to a new phase, bumping its version. */
async function moveOperation(
  transaction: PgTransactionClient,
  host: Host,
  row: OperationRow,
  change: {
    phase: string;
    result?: Record<string, unknown>;
    fence?: string;
    deadlineSeconds?: number;
  },
): Promise<OperationRow> {
  const updated = await transaction.query<OperationRow>(
    `update bakery.worker_maintenance_operations
     set phase = $3,
         result = coalesce($4::jsonb, result),
         fence = coalesce($5::bigint, fence),
         deadline_at = case when $6::integer is null then deadline_at
           else clock_timestamp() + ($6::integer * interval '1 second') end,
         updated_at = clock_timestamp(),
         version = version + 1
     where organization_id = $1 and id = $2
     returning ${OPERATION_COLUMNS}`,
    [
      host.organizationId,
      row.id,
      change.phase,
      change.result === undefined ? null : JSON.stringify(change.result),
      change.fence ?? null,
      change.deadlineSeconds ?? null,
    ],
  );
  const moved = updated.rows[0];
  if (!moved) throw new Error("WORKER_MAINTENANCE_UPDATE_FAILED");
  return moved;
}

/** True while the requesting principal still manages machines here. */
async function requesterStillAdmin(
  transaction: PgTransactionClient,
  host: Host,
  row: OperationRow,
): Promise<boolean> {
  try {
    const actor = await resolveOrganizationActor(
      transaction,
      asPrincipalId(row.requested_by),
      asOrganizationId(host.organizationId),
    );
    authorize(actor, "worker:manage", { action: "workerMaintenance.create" });
    return true;
  } catch (error) {
    if (error instanceof StandardError) return false;
    throw error;
  }
}

async function hostIsIdle(
  transaction: PgTransactionClient,
  host: Host,
): Promise<boolean> {
  const active = await transaction.query<{ busy: boolean }>(
    `select exists (
       select 1 from bakery.job_attempts
       where organization_id = $1 and worker_host_id = $2
         and status = any($3::text[])
     ) as busy`,
    [host.organizationId, host.id, ACTIVE_ATTEMPT_STATUSES],
  );
  return active.rows[0]?.busy !== true;
}

async function nextFence(
  transaction: PgTransactionClient,
  host: Host,
): Promise<string> {
  const fence = await transaction.query<{ next: string }>(
    `select (coalesce(max(fence), 0) + 1)::text as next
     from bakery.worker_maintenance_operations
     where organization_id = $1 and worker_host_id = $2`,
    [host.organizationId, host.id],
  );
  const next = fence.rows[0]?.next;
  if (!next) throw new Error("WORKER_MAINTENANCE_FENCE_MISSING");
  return next;
}

/**
 * Runs inside the heartbeat transaction, after the host row is locked:
 * expires stale requests, moves waiting operations once the host is idle,
 * hands queued operations to the host and returns every operation the host
 * must run or keep reporting on.
 */
export async function deliverMaintenance(
  transaction: PgTransactionClient,
  host: Host,
  now: Date,
  metadata: { requestId: string; traceId: string },
): Promise<unknown[]> {
  const open = await transaction.query<OperationRow & { fence: string }>(
    `select ${OPERATION_COLUMNS}, fence::text as fence
     from bakery.worker_maintenance_operations
     where organization_id = $1 and worker_host_id = $2
       and phase in ('queued', 'waiting_for_idle', 'assigned', 'applying',
         'reconciling')
     order by created_at asc, id asc
     for update`,
    [host.organizationId, host.id],
  );
  let idle: boolean | undefined;
  const isIdle = async () => idle ??= await hostIsIdle(transaction, host);
  const record = async (moved: OperationRow) => {
    await appendEvent(
      transaction,
      moved,
      host.organizationId,
      metadata.traceId,
    );
    await appendAuditRow(
      transaction,
      host,
      "worker.heartbeat",
      moved,
      metadata,
    );
    return moved;
  };
  const delivered: Array<OperationRow & { fence: string }> = [];
  for (const original of open.rows) {
    let row: OperationRow & { fence: string } = original;
    if (row.phase === "waiting_for_idle") {
      // Waiting too long needs a person; running work is never canceled.
      if (row.deadline_at <= now) {
        await record(
          await moveOperation(transaction, host, row, {
            phase: "needs_attention",
            result: { reason: "idle_wait_exceeded" },
          }),
        );
        continue;
      }
      if (!await isIdle()) continue;
      row = { ...row, phase: "queued" };
    }
    if (row.phase === "queued") {
      // An offline request never runs unexpectedly on a later reconnect.
      if (row.expires_at <= now) {
        await record(
          await moveOperation(transaction, host, row, {
            phase: "expired",
            result: { reason: "expired" },
          }),
        );
        continue;
      }
      if (isMutating(row.verb) && !await isIdle()) continue;
      const refusal = await assignmentRefusal(transaction, host, row);
      if (refusal) {
        await record(
          await moveOperation(transaction, host, row, {
            phase: "failed",
            result: { reason: refusal },
          }),
        );
        continue;
      }
      const fence = await nextFence(transaction, host);
      const assigned = await record(
        await moveOperation(transaction, host, row, {
          phase: "assigned",
          fence,
          deadlineSeconds: EXECUTION_DEADLINE_SECONDS,
        }),
      );
      delivered.push({ ...assigned, fence });
      continue;
    }
    // Assigned or applying past its deadline with no final report: the
    // acknowledgement was lost. The outcome is unknown, so the host must
    // reconcile from what is installed; nothing is failed or retried blindly.
    if (
      (row.phase === "assigned" || row.phase === "applying") &&
      row.deadline_at <= now
    ) {
      const moved = await record(
        await moveOperation(transaction, host, row, { phase: "reconciling" }),
      );
      delivered.push({ ...moved, fence: row.fence });
      continue;
    }
    if (DELIVERED_PHASES.includes(row.phase)) delivered.push(row);
  }
  return delivered.slice(0, MAX_MAINTENANCE_ASSIGNMENTS).map((row) =>
    contractSchemas.WorkerMaintenanceAssignment.parse({
      operationId: row.id,
      workerHostId: row.worker_host_id,
      credentialGeneration: row.expected_credential_generation,
      verb: row.verb,
      componentKey: row.component_key,
      targetVersion: row.target_version,
      targetDigest: row.target_digest,
      expectedInventoryRevision: row.expected_inventory_revision,
      fence: row.fence,
      deadlineAt: row.deadline_at.toISOString(),
    })
  );
}

/** Why a queued operation may no longer be handed out, or undefined. */
async function assignmentRefusal(
  transaction: PgTransactionClient,
  host: Host,
  row: OperationRow,
): Promise<string | undefined> {
  if (host.status === "revoked" || host.desiredMode === "revoked") {
    return "host_revoked";
  }
  if (row.expected_credential_generation !== host.credentialGeneration) {
    return "credential_changed";
  }
  if (!await requesterStillAdmin(transaction, host, row)) {
    return "authority_revoked";
  }
  return undefined;
}

function redactedDiagnostic(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  return redactContextText(text).text.slice(0, 8192);
}

/**
 * The final phase and result a report produces. A reconciling operation is
 * decided only by what is installed: the target digest (or, without one, the
 * target version), or for remove_component an absent digest with reason
 * removed.
 */
function decideOutcome(
  row: OperationRow,
  input: ReportInput,
): { phase: string; result?: Record<string, unknown> } {
  const observed = {
    ...(input.installedDigest === undefined
      ? {}
      : { installedDigest: input.installedDigest.toLowerCase() }),
    ...(input.installedVersion === undefined
      ? {}
      : { installedVersion: input.installedVersion }),
    ...(input.diagnostic === undefined
      ? {}
      : { diagnostic: redactedDiagnostic(input.diagnostic) }),
  };
  if (input.phase === "applying" || input.phase === "reconciling") {
    return { phase: input.phase };
  }
  if (input.phase === "rolled_back") {
    return { phase: "failed", result: { reason: "rolled_back", ...observed } };
  }
  const installed = input.installedDigest?.toLowerCase();
  if (row.phase === "reconciling") {
    const removed = row.verb === "remove_component" &&
      installed === undefined && input.reason === "removed";
    if (installed === undefined && !removed) {
      throw new StandardError({
        code: "UNPROCESSABLE",
        params: {
          issues: [{
            path: ["installedDigest"],
            code: "required",
            message:
              "installedDigest: required to decide a reconciling operation",
          }],
        },
      });
    }
    const matches = removed || matchesTarget(row, installed, input);
    return matches
      ? { phase: "succeeded", result: { reason: "reconciled", ...observed } }
      : {
        phase: "failed",
        result: { reason: "installed_digest_mismatch", ...observed },
      };
  }
  if (input.phase === "succeeded") {
    // A success that names a different installed digest is not a success.
    if (
      installed !== undefined && row.target_digest !== null &&
      installed !== row.target_digest
    ) {
      return {
        phase: "failed",
        result: { reason: "installed_digest_mismatch", ...observed },
      };
    }
    return {
      phase: "succeeded",
      result: {
        ...(input.reason ? { reason: input.reason } : {}),
        ...observed,
      },
    };
  }
  return {
    phase: "failed",
    result: { reason: input.reason ?? "failed", ...observed },
  };
}

function matchesTarget(
  row: OperationRow,
  installed: string | undefined,
  input: ReportInput,
): boolean {
  if (row.target_digest !== null) return installed === row.target_digest;
  if (row.target_version !== null) {
    return input.installedVersion === row.target_version;
  }
  return input.phase === "succeeded";
}

export async function reportMaintenance(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const operationId = context.req.param("operationId") ?? "";
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const input = await parseContract(
    context,
    contractSchemas.WorkerMaintenanceReport,
  ) as ReportInput;
  const digest = await requestDigest(input);
  const metadata = requestMetadata(context);
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const host: Host = {
        id: identity.host.id,
        organizationId: identity.host.organization_id,
        principalId: identity.host.principal_id,
        status: identity.host.status,
        desiredMode: identity.host.desired_mode,
        credentialGeneration: identity.host.credential_generation,
      };
      if (!contractSchemas.IdPath.safeParse({ id: operationId }).success) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const rows = await transaction.query<OperationRow & { fence: string }>(
        `select ${OPERATION_COLUMNS}, fence::text as fence
         from bakery.worker_maintenance_operations
         where organization_id = $1 and worker_host_id = $2 and id = $3
         for update`,
        [host.organizationId, host.id, operationId],
      );
      const row = rows.rows[0];
      if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      // A re-paired machine or a stale fence cannot speak for the operation.
      if (
        row.expected_credential_generation !== host.credentialGeneration ||
        row.fence === "0" || input.fence !== row.fence
      ) {
        throw new StandardError({ code: "AUTH_FORBIDDEN" });
      }
      const prior = await transaction.query<{
        payload_digest: string;
        response: unknown;
      }>(
        `select payload_digest, response
         from bakery.worker_maintenance_receipts
         where organization_id = $1 and operation_id = $2 and sequence = $3`,
        [host.organizationId, row.id, input.sequence],
      );
      const replay = prior.rows[0];
      if (replay) {
        if (replay.payload_digest !== digest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        return { body: replay.response, replayed: true };
      }
      const allowed = REPORT_TRANSITIONS[row.phase];
      if (TERMINAL_PHASES.has(row.phase) || !allowed) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "maintenance_finished" },
        });
      }
      const last = await transaction.query<{ last: number }>(
        `select coalesce(max(sequence), 0)::integer as last
         from bakery.worker_maintenance_receipts
         where organization_id = $1 and operation_id = $2`,
        [host.organizationId, row.id],
      );
      if (input.sequence !== (last.rows[0]?.last ?? 0) + 1) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "sequence_gap" },
        });
      }
      if (!allowed.includes(input.phase)) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "phase_not_allowed" },
        });
      }
      // Before the irreversible switch, the requester must still be an
      // Admin here; otherwise the operation stops without changing the host.
      const outcome = row.phase === "assigned" && input.phase === "applying" &&
          !await requesterStillAdmin(transaction, host, row)
        ? { phase: "failed", result: { reason: "authority_revoked" } }
        : decideOutcome(row, input);
      const moved = await moveOperation(transaction, host, row, outcome);
      await appendEvent(
        transaction,
        moved,
        host.organizationId,
        metadata.traceId,
      );
      await appendAuditRow(
        transaction,
        host,
        "worker.reportMaintenance",
        moved,
        metadata,
      );
      const response = projection(moved);
      await transaction.query(
        `insert into bakery.worker_maintenance_receipts (
           organization_id, operation_id, sequence, worker_host_id, fence,
           phase, payload_digest, response
         ) values ($1, $2, $3, $4, $5::bigint, $6, $7, $8::jsonb)`,
        [
          host.organizationId,
          row.id,
          input.sequence,
          host.id,
          row.fence,
          input.phase,
          digest,
          JSON.stringify(response),
        ],
      );
      return { body: response as unknown, replayed: false };
    },
  );
  return jsonBodyResponse(JSON.stringify(result.body), 200, result.replayed);
}
