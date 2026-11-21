import { type Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import { contractSchemas } from "@bakery/contracts/contracts";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { openMutatingMaintenance } from "@bakery/persistence/machine-readiness";
import { jsonResponse, parseContract } from "./http.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  type ExecutionRouteOptions,
  iso,
  parseIdempotencyKey,
  requestDigest,
  requestMetadata,
} from "./shared.ts";
import {
  machineTransaction,
  type MachineTransactionClient,
} from "./machines.ts";

/**
 * Remote maintenance operations (issue #25, slice A): the Admin request,
 * Developer reads and Admin cancellation of one typed, pinned operation per
 * machine. The verb and phase vocabularies and every transition rule live
 * here; the table (migration 0309) is structural, with one partial unique
 * index that keeps at most one unfinished mutating operation per host.
 *
 * Creating a mutating operation closes the worker claim gate (see
 * `openMutatingMaintenance` and the claim repository's readiness gate). It
 * never cancels or touches running attempts: a busy host waits.
 */

/** Verbs that only read the host and leave the claim gate open. */
export const READ_ONLY_VERBS: ReadonlySet<string> = new Set([
  "refresh_inventory",
  "verify",
]);
/** Phases after which the operation can never change again. */
export const TERMINAL_PHASES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
/**
 * Phases an Admin may still cancel: nothing has started on the host.
 * needs_attention (the idle wait ran out) is never delivered to the host and
 * reopens its claims, but it still holds the one-mutating slot so no
 * conflicting update can be created; an Admin clears it by canceling it.
 */
const CANCELABLE_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "waiting_for_idle",
  "assigned",
  "needs_attention",
]);
/** A busy host waits this long before the operation needs attention. */
export const IDLE_WAIT_SECONDS = 30 * 60;
/** A request that never reaches the host expires instead of running late. */
const OFFLINE_EXPIRY_SECONDS = 24 * 60 * 60;
/** Attempt statuses that still hold a slot on the host. */
export const ACTIVE_ATTEMPT_STATUSES = ["leased", "running", "canceling"];

export type OperationRow = {
  id: string;
  worker_host_id: string;
  verb: string;
  component_key: string | null;
  target_version: string | null;
  target_digest: string | null;
  requested_by: string;
  expected_inventory_revision: number;
  expected_credential_generation: number;
  captured_desired_mode: string;
  phase: string;
  deadline_at: Date;
  expires_at: Date;
  request_digest: string;
  result: unknown;
  created_at: Date;
  updated_at: Date;
  version: number;
};

export const OPERATION_COLUMNS = `id, worker_host_id, verb, component_key,
  target_version, target_digest, requested_by, expected_inventory_revision,
  expected_credential_generation, captured_desired_mode, phase, deadline_at,
  expires_at, request_digest, result, created_at, updated_at, version`;

export function projection(row: OperationRow) {
  return contractSchemas.WorkerMaintenanceOperation.parse({
    id: row.id,
    workerHostId: row.worker_host_id,
    verb: row.verb,
    componentKey: row.component_key,
    targetVersion: row.target_version,
    targetDigest: row.target_digest,
    requestedBy: row.requested_by,
    expectedInventoryRevision: row.expected_inventory_revision,
    expectedCredentialGeneration: row.expected_credential_generation,
    capturedDesiredMode: row.captured_desired_mode,
    phase: row.phase,
    deadlineAt: iso(row.deadline_at),
    expiresAt: iso(row.expires_at),
    result: row.result ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    version: row.version,
  });
}

export function isMutating(verb: string): boolean {
  return !READ_ONLY_VERBS.has(verb);
}

/** A 422 whose bounded issue names the field and the machine reason code. */
function unprocessable(field: string, reason: string): StandardError {
  return new StandardError({
    code: "UNPROCESSABLE",
    params: {
      issues: [{
        path: [field],
        code: reason,
        message: `${field}: ${reason.replaceAll("_", " ")}`,
      }],
    },
  });
}

/** Per-verb shape rules the generated schema cannot express. */
function assertVerbShape(input: {
  verb: string;
  componentKey?: string;
  targetVersion?: string;
  targetDigest?: string;
}): void {
  const needsComponent = input.verb !== "refresh_inventory" &&
    input.verb !== "verify";
  if (needsComponent && input.componentKey === undefined) {
    throw unprocessable("componentKey", "required");
  }
  if (input.verb === "refresh_inventory" && input.componentKey !== undefined) {
    throw unprocessable("componentKey", "not_allowed");
  }
  const needsVersion = input.verb === "install_component" ||
    input.verb === "update_component";
  const allowsVersion = needsVersion || input.verb === "rollback_component";
  if (needsVersion && input.targetVersion === undefined) {
    throw unprocessable("targetVersion", "required");
  }
  if (!allowsVersion && input.targetVersion !== undefined) {
    throw unprocessable("targetVersion", "not_allowed");
  }
  if (input.targetDigest !== undefined && input.targetVersion === undefined) {
    throw unprocessable("targetDigest", "not_allowed");
  }
}

async function appendMaintenanceEvent(
  transaction: MachineTransactionClient,
  organizationId: string,
  row: OperationRow,
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

async function appendMaintenanceAudit(
  transaction: MachineTransactionClient,
  options: {
    organizationId: string;
    principalId: string;
    operation: "workerMaintenance.create" | "workerMaintenance.cancel";
    row: OperationRow;
    requestId: string;
    traceId: string;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.audit_events (
       organization_id, principal_id, operation, resource_type,
       resource_id, outcome, request_id, trace_id, details
     ) values ($1, $2, $3, 'worker_maintenance_operation', $4,
       'succeeded', $5, $6, $7::jsonb)`,
    [
      options.organizationId,
      options.principalId,
      options.operation,
      options.row.id,
      options.requestId,
      options.traceId,
      JSON.stringify({
        workerHostId: options.row.worker_host_id,
        verb: options.row.verb,
        phase: options.row.phase,
      }),
    ],
  );
}

/**
 * Revocation ends every unfinished operation on the host in the same
 * transaction: the host has lost the authority to apply or report, so the
 * operation becomes canceled with reason host_revoked and nothing lingers
 * nonterminal.
 */
export async function cancelOpenMaintenanceOnRevoke(
  transaction: MachineTransactionClient,
  organizationId: string,
  principalId: string,
  workerHostId: string,
  metadata: { requestId: string; traceId: string },
): Promise<void> {
  const updated = await transaction.query<OperationRow>(
    `update bakery.worker_maintenance_operations
     set phase = 'canceled', result = $3::jsonb,
         updated_at = clock_timestamp(), version = version + 1
     where organization_id = $1 and worker_host_id = $2
       and phase <> all($4::text[])
     returning ${OPERATION_COLUMNS}`,
    [
      organizationId,
      workerHostId,
      JSON.stringify({ reason: "host_revoked" }),
      [...TERMINAL_PHASES],
    ],
  );
  for (const row of updated.rows) {
    await appendMaintenanceEvent(
      transaction,
      organizationId,
      row,
      metadata.traceId,
    );
    await appendMaintenanceAudit(transaction, {
      organizationId,
      principalId,
      operation: "workerMaintenance.cancel",
      row,
      requestId: metadata.requestId,
      traceId: metadata.traceId,
    });
  }
}

export async function createWorkerMaintenance(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const input = await parseContract(
    context,
    contractSchemas.WorkerMaintenanceCreate,
  );
  const digest = await requestDigest(input);
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerMaintenance.create",
    async (transaction, organization, principal) => {
      assertPathIds(workerHostId);
      // The scheduling lock: the worker claim path loads this row FOR UPDATE
      // too, so the claim gate closes atomically with the insert below.
      const hosts = await transaction.query<{
        status: string;
        desired_mode: string;
        credential_generation: number;
        inventory_revision: number;
      }>(
        `select status, desired_mode, credential_generation, inventory_revision
         from bakery.worker_hosts
         where organization_id = $1 and id = $2
         for update`,
        [organization, workerHostId],
      );
      const host = hosts.rows[0];
      if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });

      const prior = await transaction.query<OperationRow>(
        `select ${OPERATION_COLUMNS}
         from bakery.worker_maintenance_operations
         where organization_id = $1 and worker_host_id = $2
           and idempotency_key = $3`,
        [organization, workerHostId, idempotencyKey],
      );
      const replay = prior.rows[0];
      if (replay) {
        if (replay.request_digest !== digest) {
          throw new StandardError({ code: "IDEMPOTENCY_PAYLOAD_MISMATCH" });
        }
        return jsonResponse(projection(replay), 201, true);
      }

      if (host.status === "revoked" || host.desired_mode === "revoked") {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "revoked" },
        });
      }
      assertVerbShape(input);
      if (
        input.expectedInventoryRevision !== undefined &&
        input.expectedInventoryRevision !== host.inventory_revision
      ) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "inventory_changed" },
        });
      }
      if (input.componentKey !== undefined) {
        const components = await transaction.query<{ install_owner: string }>(
          `select install_owner from bakery.worker_components
           where organization_id = $1 and worker_host_id = $2
             and component_key = $3`,
          [organization, workerHostId, input.componentKey],
        );
        const component = components.rows[0];
        // Installing is the only verb that may name a component the host
        // has not reported yet; every other verb acts on known inventory.
        if (!component && input.verb !== "install_component") {
          throw unprocessable("componentKey", "unknown_component");
        }
        if (component && component.install_owner !== "bakery") {
          throw unprocessable("componentKey", "externally_managed");
        }
      }
      if (
        isMutating(input.verb) &&
        await openMutatingMaintenance(transaction, workerHostId)
      ) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "maintenance_in_progress" },
        });
      }
      const active = await transaction.query<{ count: string }>(
        `select count(*)::text as count from bakery.job_attempts
         where organization_id = $1 and worker_host_id = $2
           and status = any($3::text[])`,
        [organization, workerHostId, ACTIVE_ATTEMPT_STATUSES],
      );
      // Running work keeps its pinned versions and finishes first; nothing
      // here cancels or changes an attempt.
      const phase = isMutating(input.verb) && Number(active.rows[0]?.count) > 0
        ? "waiting_for_idle"
        : "queued";
      const inserted = await transaction.query<OperationRow>(
        `insert into bakery.worker_maintenance_operations (
           organization_id, worker_host_id, verb, component_key,
           target_version, target_digest, requested_by,
           expected_inventory_revision, expected_credential_generation,
           captured_desired_mode, phase, deadline_at, expires_at,
           idempotency_key, request_digest
         ) values (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
           clock_timestamp() + ($12::integer * interval '1 second'),
           clock_timestamp() + ($13::integer * interval '1 second'),
           $14, $15
         )
         returning ${OPERATION_COLUMNS}`,
        [
          organization,
          workerHostId,
          input.verb,
          input.componentKey ?? null,
          input.targetVersion ?? null,
          input.targetDigest?.toLowerCase() ?? null,
          principal.principalId,
          host.inventory_revision,
          host.credential_generation,
          host.desired_mode,
          phase,
          IDLE_WAIT_SECONDS,
          OFFLINE_EXPIRY_SECONDS,
          idempotencyKey,
          digest,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("WORKER_MAINTENANCE_INSERT_FAILED");
      await appendMaintenanceEvent(
        transaction,
        organization,
        row,
        metadata.traceId,
      );
      await appendMaintenanceAudit(transaction, {
        organizationId: organization,
        principalId: principal.principalId,
        operation: "workerMaintenance.create",
        row,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
      });
      return jsonResponse(projection(row), 201, false);
    },
  );
}

async function loadOperation(
  transaction: MachineTransactionClient,
  organization: string,
  workerHostId: string,
  operationId: string,
  lock: boolean,
): Promise<OperationRow> {
  assertPathIds(workerHostId, operationId);
  const rows = await transaction.query<OperationRow>(
    `select ${OPERATION_COLUMNS}
     from bakery.worker_maintenance_operations
     where organization_id = $1 and worker_host_id = $2 and id = $3
     ${lock ? "for update" : ""}`,
    [organization, workerHostId, operationId],
  );
  const row = rows.rows[0];
  if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  return row;
}

/** A malformed path ID cannot name a visible resource. */
function assertPathIds(...ids: string[]): void {
  for (const id of ids) {
    if (!contractSchemas.IdPath.safeParse({ id }).success) {
      throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    }
  }
}

async function assertHostVisible(
  transaction: MachineTransactionClient,
  organization: string,
  workerHostId: string,
): Promise<void> {
  assertPathIds(workerHostId);
  const hosts = await transaction.query<{ id: string }>(
    `select id from bakery.worker_hosts
     where organization_id = $1 and id = $2`,
    [organization, workerHostId],
  );
  if (hosts.rows.length === 0) {
    throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  }
}

export async function listWorkerMaintenance(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "workerMaintenance.list",
    async (transaction, organization, principal) => {
      const binding: CursorBinding = {
        action: "workerMaintenance.list",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "createdAt:desc,id:desc",
        filters: JSON.stringify({ workerHostId }),
        schemaVersion: 1,
      };
      const parsed = contractSchemas.CursorQuery.safeParse({
        ...(context.req.query("cursor") === undefined
          ? {}
          : { cursor: context.req.query("cursor") }),
        ...(context.req.query("limit") === undefined
          ? {}
          : { limit: Number(context.req.query("limit")) }),
      });
      if (!parsed.success) {
        throw new StandardError({
          code: "MALFORMED_REQUEST",
          cause: parsed.error,
        });
      }
      const limit = parsed.data.limit ?? 25;
      await assertHostVisible(transaction, organization, workerHostId);
      const position = await decodeCursor(
        options.secret,
        parsed.data.cursor,
        binding,
      );
      const rows = await transaction.query<
        OperationRow & { created_at_key: string }
      >(
        `select ${OPERATION_COLUMNS},
                to_char(
                  created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) as created_at_key
         from bakery.worker_maintenance_operations
         where organization_id = $1 and worker_host_id = $2
           and ($3::timestamptz is null or (created_at, id) < ($3, $4::uuid))
         order by created_at desc, id desc
         limit $5`,
        [
          organization,
          workerHostId,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = rows.rows.slice(0, limit);
      const last = visible.at(-1);
      const nextCursor = rows.rows.length > limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.created_at_key,
          id: last.id,
        })
        : null;
      const page = contractSchemas["Page<WorkerMaintenanceOperation>"].parse({
        items: visible.map(projection),
        nextCursor,
      });
      return jsonResponse(page, 200, false);
    },
  );
}

export async function getWorkerMaintenance(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const operationId = context.req.param("operationId") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "workerMaintenance.get",
    async (transaction, organization) => {
      const row = await loadOperation(
        transaction,
        organization,
        workerHostId,
        operationId,
        false,
      );
      return jsonResponse(projection(row), 200, false);
    },
  );
}

export async function cancelWorkerMaintenance(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const operationId = context.req.param("operationId") ?? "";
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerMaintenance.cancel",
    async (transaction, organization, principal) => {
      const row = await loadOperation(
        transaction,
        organization,
        workerHostId,
        operationId,
        true,
      );
      if (row.phase === "canceled") {
        return jsonResponse(projection(row), 200, true);
      }
      // Once the host has started applying, cancellation would interrupt a
      // filesystem change halfway; the operation reconciles instead.
      if (!CANCELABLE_PHASES.has(row.phase) || TERMINAL_PHASES.has(row.phase)) {
        throw new StandardError({
          code: "STATE_CONFLICT",
          params: { reason: "not_cancelable" },
        });
      }
      const updated = await transaction.query<OperationRow>(
        `update bakery.worker_maintenance_operations
         set phase = 'canceled', updated_at = clock_timestamp(),
             version = version + 1
         where organization_id = $1 and id = $2
         returning ${OPERATION_COLUMNS}`,
        [organization, row.id],
      );
      const canceled = updated.rows[0];
      if (!canceled) throw new Error("WORKER_MAINTENANCE_CANCEL_FAILED");
      await appendMaintenanceEvent(
        transaction,
        organization,
        canceled,
        metadata.traceId,
      );
      await appendMaintenanceAudit(transaction, {
        organizationId: organization,
        principalId: principal.principalId,
        operation: "workerMaintenance.cancel",
        row: canceled,
        requestId: metadata.requestId,
        traceId: metadata.traceId,
      });
      return jsonResponse(projection(canceled), 200, false);
    },
  );
}
