import { type Context } from "hono";
import { StandardError } from "@bakery/contracts/http";
import {
  connectivityState,
  createMachineReadinessWorkflows,
  derivedEnrollmentState,
  dispatchGate,
  evaluateReadiness,
} from "@bakery/persistence/machine-readiness";
import { IDEMPOTENCY_REPLAY_TTL_SECONDS } from "@bakery/persistence";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { jsonResponse, parseContract } from "./http.ts";
import type { AuthVariables } from "../auth/middleware.ts";
import { authorize } from "../auth/application/authorize.ts";
import { resolveOrganizationActor } from "../auth/adapters/authority-postgres.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import {
  type CatalogActionName,
  contractSchemas,
  type OrganizationId,
  organizationId as asOrganizationId,
} from "@bakery/contracts/contracts";
import {
  ENROLLMENT_TTL_MS,
  type ExecutionRouteOptions,
  iso,
  parseIdempotencyKey,
  protect,
  randomSecret,
  requestMetadata,
  sha256Hex,
  unprotect,
  withPgTransaction,
  workerTransaction,
} from "./shared.ts";

const WORKER_UPDATE_STATUS_DESIRED_MODE: Record<string, string> = {
  online: "accepting",
  offline: "paused",
  draining: "draining",
  revoked: "revoked",
};
type CursorQueryInput = { cursor?: string; limit?: number };

function parseCursorQuery(
  context: Context<{ Variables: AuthVariables }>,
): CursorQueryInput {
  const search = new URL(context.req.url).searchParams;
  const keys = [...search.keys()];
  const cursors = search.getAll("cursor");
  const limits = search.getAll("limit");
  if (
    cursors.length > 1 ||
    limits.length > 1 ||
    keys.some((key) => key !== "cursor" && key !== "limit")
  ) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const rawLimit = limits[0];
  if (rawLimit !== undefined && !/^[1-9][0-9]*$/u.test(rawLimit)) {
    throw new StandardError({ code: "MALFORMED_REQUEST" });
  }
  const parsed = contractSchemas.CursorQuery.safeParse({
    ...(cursors[0] === undefined ? {} : { cursor: cursors[0] }),
    ...(rawLimit === undefined ? {} : { limit: Number(rawLimit) }),
  });
  if (!parsed.success) {
    throw new StandardError({ code: "MALFORMED_REQUEST", cause: parsed.error });
  }
  return parsed.data;
}

type AuthVariables0 = AuthVariables["principal"];
type AuthenticatedSubject = NonNullable<AuthVariables0>;

export type MachineTransactionClient = Parameters<
  Parameters<typeof withPgTransaction>[1]
>[0];

/**
 * Organization-scoped transaction with an explicit permission key. Machine
 * routes mix Admin maintenance (worker:manage) and Developer safe reads
 * (worker:read) over the same resources, so the permission is a parameter
 * instead of a hardcoded admin key.
 */
export async function machineTransaction<T>(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
  permission: "worker:read" | "worker:manage",
  action: CatalogActionName,
  work: (
    transaction: MachineTransactionClient,
    organization: OrganizationId,
    principal: AuthenticatedSubject,
  ) => Promise<T>,
): Promise<T> {
  const principal = context.get("principal");
  if (!principal) throw new StandardError({ code: "AUTH_REQUIRED" });
  const organizationHeader = context.req.header("Bakery-Organization-Id");
  if (!organizationHeader) throw new StandardError({ code: "AUTH_FORBIDDEN" });
  let organization: OrganizationId;
  try {
    organization = asOrganizationId(organizationHeader);
  } catch (cause) {
    throw new StandardError({ code: "AUTH_FORBIDDEN", cause });
  }
  return await withPgTransaction(options.database, async (transaction) => {
    const actor = await resolveOrganizationActor(
      transaction,
      principal.principalId,
      organization,
    );
    authorize(actor, permission, { action });
    return await work(transaction, organization, principal);
  }, context.req.raw.signal);
}

export function readinessWorkflows(
  transaction: MachineTransactionClient,
  options: ExecutionRouteOptions,
) {
  return createMachineReadinessWorkflows(transaction, {
    replayTtlSeconds: IDEMPOTENCY_REPLAY_TTL_SECONDS,
    enrollmentTtlSeconds: ENROLLMENT_TTL_MS / 1000,
    randomSecret,
    hash: sha256Hex,
    protect: (value) => protect(options.secret, value),
    unprotect: (value) => unprotect(options.secret, value),
  });
}

export function noStoreJsonResponse(
  value: unknown,
  status: 200 | 201,
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** Safe, server-derived worker status projection for Developer reads. */
async function safeWorkerProjection(
  transaction: MachineTransactionClient,
  hostId: string,
): Promise<Record<string, unknown> | null> {
  const result = await transaction.query<{
    id: string;
    organization_id: string;
    principal_id: string;
    name: string;
    os: string;
    architecture: string;
    capabilities: unknown;
    toolchain_versions: unknown;
    slots: number;
    status: string;
    desired_mode: string;
    last_heartbeat_at: Date | null;
    credential_generation: number;
    inventory_revision: number;
    created_at: Date;
    updated_at: Date;
    version: number;
    now: Date;
  }>(
    `select id, organization_id, principal_id, name, os, architecture,
            capabilities, toolchain_versions, slots, status, desired_mode,
            last_heartbeat_at, credential_generation, inventory_revision,
            created_at, updated_at, version, clock_timestamp() as now
     from bakery.worker_hosts
     where id = $1`,
    [hostId],
  );
  const host = result.rows[0];
  if (!host) return null;
  const checks = await transaction.query<{
    check_id: string;
    status: string;
    host_generation: number;
    inventory_revision: number;
    expires_at: Date;
  }>(
    `select check_id, status, host_generation, inventory_revision, expires_at
     from bakery.worker_checks
     where worker_host_id = $1`,
    [host.id],
  );
  // Same database clock the heartbeat writes, so skew cannot flip stale.
  const now = host.now;
  const connectivity = connectivityState(host.last_heartbeat_at, now);
  const readiness = evaluateReadiness({
    now,
    connectivity,
    status: host.status,
    desiredMode: host.desired_mode,
    credentialGeneration: host.credential_generation,
    inventoryRevision: host.inventory_revision,
    checks: checks.rows.map((row) => ({
      checkId: row.check_id,
      componentKey: null,
      status: row.status,
      hostGeneration: row.host_generation,
      inventoryRevision: row.inventory_revision,
      expiresAt: row.expires_at,
    })),
  });
  return contractSchemas.WorkerHost.parse({
    id: host.id,
    principalId: host.principal_id,
    name: host.name,
    os: host.os,
    architecture: host.architecture,
    capabilities: host.capabilities ?? [],
    toolchainVersions: host.toolchain_versions ?? {},
    slots: host.slots,
    status: host.status,
    desiredMode: host.desired_mode,
    connectivity,
    readiness: readiness.state,
    readinessReason: readiness.reason,
    failedCheckIds: readiness.failedCheckIds,
    lastHeartbeatAt: host.last_heartbeat_at
      ? iso(host.last_heartbeat_at)
      : null,
    credentialGeneration: host.credential_generation,
    createdAt: iso(host.created_at),
    updatedAt: iso(host.updated_at),
    version: host.version,
  }) as unknown as Record<string, unknown>;
}

async function appendWorkerEvent(
  transaction: MachineTransactionClient,
  organizationId: string,
  eventType: string,
  workerHostId: string,
  resourceVersion: number,
  traceId: string,
): Promise<void> {
  await appendDomainEvent(transaction, {
    organizationId,
    eventType,
    aggregateId: workerHostId,
    aggregateVersion: resourceVersion,
    workerHostId,
    payload: { resourceId: workerHostId, resourceVersion },
    traceId,
  });
}

export async function inspectEnrollment(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const input = await parseContract(
    context,
    contractSchemas.WorkerEnrollmentInspect,
  );
  const enrollmentHash = await sha256Hex(input.enrollmentToken);
  return await withPgTransaction(options.database, async (transaction) => {
    const workflows = readinessWorkflows(transaction, options);
    const inspection = await workflows.inspectEnrollment({ enrollmentHash });
    if (inspection.state === "consumed") {
      throw new StandardError({ code: "STATE_CONFLICT" });
    }
    const projection = contractSchemas.WorkerEnrollmentInspection.parse(
      inspection as unknown as Record<string, unknown>,
    );
    return noStoreJsonResponse(projection, 200);
  }, context.req.raw.signal);
}

export async function workerEnrollmentStatus(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const enrollmentId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerEnrollments.get",
    async (transaction, organization) => {
      const workflows = readinessWorkflows(transaction, options);
      const status = await workflows.enrollmentStatus({
        organizationId: organization,
        enrollmentId,
        now: new Date(),
      });
      let worker: Record<string, unknown> | null = null;
      const workerHostId = status.response.workerHostId as string | null;
      if (workerHostId) {
        worker = await safeWorkerProjection(transaction, workerHostId);
      }
      const response = contractSchemas.EnrollmentStatus.parse({
        ...status.response,
        worker,
      });
      return jsonResponse(response, 200, false);
    },
  );
}
export async function listWorkerEnrollments(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "workerEnrollments.list",
    async (transaction, organization, principal) => {
      const binding: CursorBinding = {
        action: "workerEnrollments.list",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "createdAt:desc,id:desc",
        filters: JSON.stringify({}),
        schemaVersion: 1,
      };
      const query = parseCursorQuery(context);
      const limit = query.limit ?? 25;
      const position = await decodeCursor(
        options.secret,
        query.cursor,
        binding,
      );
      const rows = await transaction.query<{
        id: string;
        name: string;
        os: string;
        architecture: string;
        allowed_capabilities: unknown;
        slots: number;
        expires_at: Date | string;
        consumed_at: Date | string | null;
        canceled_at: Date | string | null;
        worker_host_id: string | null;
        replacement_of_id: string | null;
        target_worker_host_id: string | null;
        version: number;
        created_at: string;
      }>(
        `select id, name, os, architecture, allowed_capabilities, slots,
                expires_at, consumed_at, canceled_at, worker_host_id,
                replacement_of_id, target_worker_host_id, version,
                to_char(
                  created_at at time zone 'UTC',
                  'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                ) as created_at
         from bakery.worker_enrollments
         where organization_id = $1
           and ($2::timestamptz is null or (created_at, id) < ($2, $3::uuid))
         order by created_at desc, id desc
         limit $4`,
        [
          organization,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = rows.rows.slice(0, limit);
      const now = new Date();
      const items = visible.map((row) => ({
        enrollmentId: row.id,
        state: derivedEnrollmentState({
          consumedAt: row.consumed_at,
          canceledAt: row.canceled_at,
          expiresAt: row.expires_at,
          now,
        }),
        name: row.name,
        os: row.os,
        architecture: row.architecture,
        capabilities: Array.isArray(row.allowed_capabilities) &&
            row.allowed_capabilities.every((entry) => typeof entry === "string")
          ? row.allowed_capabilities
          : [],
        slots: row.slots,
        expiresAt: iso(row.expires_at),
        consumedAt: row.consumed_at ? iso(row.consumed_at) : null,
        canceledAt: row.canceled_at ? iso(row.canceled_at) : null,
        workerHostId: row.worker_host_id,
        replacementOfId: row.replacement_of_id,
        targetWorkerHostId: row.target_worker_host_id,
        version: row.version,
      }));
      const last = visible.at(-1);
      const nextCursor = rows.rows.length > limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.created_at,
          id: last.id,
        })
        : null;
      const page = contractSchemas["Page<WorkerEnrollmentSummary>"].parse({
        items,
        nextCursor,
      });
      return jsonResponse(page, 200, false);
    },
  );
}

export async function cancelWorkerEnrollment(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const enrollmentId = context.req.param("id") ?? "";
  await parseContract(context, contractSchemas.WorkerEnrollmentCancel);
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerEnrollments.cancel",
    async (transaction, organization, principal) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.cancelEnrollment({
        organizationId: organization,
        principalId: principal.principalId,
        enrollmentId,
        idempotencyKey,
        requestDigest: enrollmentId,
        metadata,
        now: new Date(),
      });
      const response = contractSchemas.EnrollmentStatus.parse({
        ...result.response,
        worker: null,
      });
      return jsonResponse(response, 200, result.replayed);
    },
  );
}

export async function replaceWorkerEnrollment(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const enrollmentId = context.req.param("id") ?? "";
  await parseContract(context, contractSchemas.WorkerEnrollmentReplace);
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workerEnrollments.replace",
    async (transaction, organization, principal) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.replaceEnrollment({
        organizationId: organization,
        principalId: principal.principalId,
        enrollmentId,
        idempotencyKey,
        requestDigest: enrollmentId,
        metadata,
        now: new Date(),
      });
      const response = contractSchemas.WorkerEnrollment.parse(result.response);
      return jsonResponse(response, 201, result.replayed);
    },
  );
}

export async function repairWorkerEnrollment(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const idempotencyKey = parseIdempotencyKey(
    context.req.header("Idempotency-Key"),
  );
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workers.repairEnrollment",
    async (transaction, organization, principal) => {
      const workflows = readinessWorkflows(transaction, options);
      const result = await workflows.repairEnrollment({
        organizationId: organization,
        principalId: principal.principalId,
        workerHostId,
        idempotencyKey,
        requestDigest: workerHostId,
        metadata,
        now: new Date(),
      });
      const response = contractSchemas.WorkerEnrollment.parse(result.response);
      return jsonResponse(response, 201, result.replayed);
    },
  );
}

export async function revokeWorker(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  parseIdempotencyKey(context.req.header("Idempotency-Key"));
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workers.revoke",
    async (transaction, organization, principal) => {
      const hosts = await transaction.query<{ id: string; status: string }>(
        `select id, status from bakery.worker_hosts
         where organization_id = $1 and id = $2
         for update`,
        [organization, workerHostId],
      );
      const host = hosts.rows[0];
      if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      if (host.status === "revoked") {
        throw new StandardError({ code: "STATE_CONFLICT" });
      }
      // Terminal for the credential generation: claims deny immediately, and
      // offline cleanup stays unconfirmed until the host is seen again.
      const updated = await transaction.query<{ version: number }>(
        `update bakery.worker_hosts
         set status = 'revoked', desired_mode = 'revoked',
             credential_generation = credential_generation + 1,
             updated_at = current_timestamp, version = version + 1
         where organization_id = $1 and id = $2
         returning version`,
        [organization, workerHostId],
      );
      const version = updated.rows[0]?.version ?? 1;
      await appendWorkerEvent(
        transaction,
        organization,
        "worker.updated",
        workerHostId,
        version,
        metadata.traceId,
      );
      await transaction.query(
        `insert into bakery.audit_events (
           organization_id, principal_id, operation, resource_type,
           resource_id, outcome, request_id, trace_id, details
         ) values ($1, $2, 'workers.revoke', 'worker_host', $3,
           'succeeded', $4, $5, '{}'::jsonb)`,
        [
          organization,
          principal.principalId,
          workerHostId,
          metadata.requestId,
          metadata.traceId,
        ],
      );
      const projection = await safeWorkerProjection(transaction, workerHostId);
      const response = contractSchemas.WorkerHost.parse(projection);
      return jsonResponse(response, 200, false);
    },
  );
}

export async function listWorkers(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "workers.list",
    async (transaction, organization, principal) => {
      const binding: CursorBinding = {
        action: "workers.list",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "createdAt:asc,id:asc",
        filters: JSON.stringify({}),
        schemaVersion: 1,
      };
      const cursor = context.req.query("cursor") ?? undefined;
      const limit = Math.min(Number(context.req.query("limit") ?? 25), 100);
      const position = await decodeCursor(options.secret, cursor, binding);
      const rows = await transaction.query<{ id: string; created_at: Date }>(
        `select id, created_at from bakery.worker_hosts
         where organization_id = $1
           and ($2::timestamptz is null or (created_at, id) > ($2, $3::uuid))
         order by created_at asc, id asc
         limit $4`,
        [
          organization,
          position?.createdAt ?? null,
          position?.id ?? null,
          limit + 1,
        ],
      );
      const visible = rows.rows.slice(0, limit);
      const items = [];
      for (const row of visible) {
        const projection = await safeWorkerProjection(transaction, row.id);
        if (projection) items.push(projection);
      }
      const last = visible.at(-1);
      const nextCursor = rows.rows.length > limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.created_at.toISOString(),
          id: last.id,
        })
        : null;
      const page = contractSchemas["Page<WorkerHost>"].parse({
        items,
        nextCursor,
      });
      return jsonResponse(page, 200, false);
    },
  );
}
export async function dispatchBlockers(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "machines.dispatchBlockers",
    async (transaction, organization) => {
      const hosts = await transaction.query<{
        credential_generation: number;
        inventory_revision: number;
        status: string;
        desired_mode: string;
        last_heartbeat_at: Date | null;
        now: Date;
      }>(
        `select credential_generation, inventory_revision, status,
                desired_mode, last_heartbeat_at,
                clock_timestamp() as now
         from bakery.worker_hosts
         where organization_id = $1 and id = $2
         for update`,
        [organization, workerHostId],
      );
      const host = hosts.rows[0];
      if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const checks = await transaction.query<{
        check_id: string;
        status: string;
        reason: string | null;
        host_generation: number;
        inventory_revision: number;
        expires_at: Date | string;
      }>(
        `select check_id, status, reason, host_generation,
                inventory_revision, expires_at
         from bakery.worker_checks
         where organization_id = $1 and worker_host_id = $2
         order by check_id asc, id asc`,
        [organization, workerHostId],
      );
      const connectivity = connectivityState(host.last_heartbeat_at, host.now);
      const projection = dispatchGate({
        now: host.now,
        connectivity,
        status: host.status,
        desiredMode: host.desired_mode,
        credentialGeneration: host.credential_generation,
        inventoryRevision: host.inventory_revision,
        checks: checks.rows.map((row) => ({
          checkId: row.check_id,
          componentKey: null,
          status: row.status,
          reason: row.reason,
          hostGeneration: row.host_generation,
          inventoryRevision: row.inventory_revision,
          expiresAt: row.expires_at,
        })),
      });
      const response = contractSchemas.DispatchBlockers.parse({
        workerHostId,
        ...projection,
        connectivity,
        credentialGeneration: host.credential_generation,
        inventoryRevision: host.inventory_revision,
      });
      return jsonResponse(response, 200, false);
    },
  );
}

export async function getWorker(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "workers.get",
    async (transaction, organization) => {
      const hosts = await transaction.query<{ id: string }>(
        `select id from bakery.worker_hosts
         where organization_id = $1 and id = $2`,
        [organization, workerHostId],
      );
      if (hosts.rows.length === 0) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const projection = await safeWorkerProjection(transaction, workerHostId);
      const response = contractSchemas.WorkerHost.parse(projection);
      return jsonResponse(response, 200, false);
    },
  );
}

export async function updateWorker(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  const input = await parseContract(context, contractSchemas.WorkerUpdate);
  const metadata = requestMetadata(context);
  return await machineTransaction(
    context,
    options,
    "worker:manage",
    "workers.update",
    async (transaction, organization, principal) => {
      const hosts = await transaction.query<{
        id: string;
        version: number;
        status: string;
      }>(
        `select id, version, status from bakery.worker_hosts
         where organization_id = $1 and id = $2
         for update`,
        [organization, workerHostId],
      );
      const host = hosts.rows[0];
      if (!host) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      const ifMatch = context.req.header("If-Match");
      if (ifMatch !== undefined && ifMatch !== `"${host.version}"`) {
        throw new StandardError({ code: "PRECONDITION_FAILED" });
      }
      if (input.status !== undefined) {
        const desiredMode = WORKER_UPDATE_STATUS_DESIRED_MODE[input.status] ??
          "accepting";
        if (host.status === "revoked" && desiredMode !== "revoked") {
          throw new StandardError({ code: "STATE_CONFLICT" });
        }
        await transaction.query(
          `update bakery.worker_hosts
           set desired_mode = $3, updated_at = current_timestamp,
               version = version + 1
           where organization_id = $1 and id = $2`,
          [organization, workerHostId, desiredMode],
        );
      }
      if (input.slots !== undefined) {
        if (input.slots < 1 || input.slots > 100) {
          throw new StandardError({ code: "UNPROCESSABLE" });
        }
        await transaction.query(
          `update bakery.worker_hosts
           set slots = $3, updated_at = current_timestamp,
               version = version + 1
           where organization_id = $1 and id = $2`,
          [organization, workerHostId, input.slots],
        );
      }
      const projection = await safeWorkerProjection(transaction, workerHostId);
      const response = contractSchemas.WorkerHost.parse(projection);
      await appendWorkerEvent(
        transaction,
        organization,
        "worker.updated",
        workerHostId,
        response.version,
        metadata.traceId,
      );
      await transaction.query(
        `insert into bakery.audit_events (
           organization_id, principal_id, operation, resource_type,
           resource_id, outcome, request_id, trace_id, details
         ) values ($1, $2, 'workers.update', 'worker_host', $3,
           'succeeded', $4, $5, '{}'::jsonb)`,
        [
          organization,
          principal.principalId,
          workerHostId,
          metadata.requestId,
          metadata.traceId,
        ],
      );
      return jsonResponse(response, 200, false);
    },
  );
}

export async function listWorkerComponents(
  context: Context<{ Variables: AuthVariables }>,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const workerHostId = context.req.param("id") ?? "";
  return await machineTransaction(
    context,
    options,
    "worker:read",
    "workerComponents.list",
    async (transaction, organization, principal) => {
      const binding: CursorBinding = {
        action: "workerComponents.list",
        organizationId: organization,
        principalId: principal.principalId,
        ordering: "observedAt:asc,id:asc",
        filters: JSON.stringify({ workerHostId }),
        schemaVersion: 1,
      };
      const cursor = context.req.query("cursor") ?? undefined;
      const limit = Math.min(Number(context.req.query("limit") ?? 25), 100);
      const hosts = await transaction.query<{ id: string }>(
        `select id from bakery.worker_hosts
         where organization_id = $1 and id = $2`,
        [organization, workerHostId],
      );
      if (hosts.rows.length === 0) {
        throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
      }
      const position = await decodeCursor(options.secret, cursor, binding);
      const rows = await transaction.query<
        Record<string, unknown> & {
          observed_at: Date;
          id: string;
        }
      >(
        `select id, component_key as "componentKey", kind,
                actual_version as "actualVersion", actual_digest as "actualDigest",
                install_owner as "installOwner", adapter_version as "adapterVersion",
                available_version as "availableVersion", channel, observed_at,
                maintenance_support as "maintenanceSupport"
         from bakery.worker_components
         where organization_id = $1 and worker_host_id = $2
           and ($3::timestamptz is null or (observed_at, id) > ($3, $4::uuid))
         order by observed_at asc, id asc
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
      const items = visible.map(({ observed_at, ...component }) =>
        contractSchemas.WorkerComponent.parse({
          ...component,
          observedAt: iso(observed_at),
        })
      );
      const last = visible.at(-1);
      const nextCursor = rows.rows.length > limit && last
        ? await encodeCursor(options.secret, binding, {
          createdAt: last.observed_at.toISOString(),
          id: last.id,
        })
        : null;
      const page = contractSchemas["Page<WorkerComponent>"].parse({
        items,
        nextCursor,
      });
      return jsonResponse(page, 200, false);
    },
  );
}

export async function reportInventory(
  context: Context,
  options: ExecutionRouteOptions,
): Promise<Response> {
  const input = await parseContract(
    context,
    contractSchemas.WorkerInventoryReport,
  );
  const metadata = requestMetadata(context);
  const result = await workerTransaction(
    options.database,
    context.req.raw.headers,
    async (transaction, identity) => {
      const workflows = readinessWorkflows(transaction, options);
      return await workflows.reportInventory({
        identity: {
          tokenHash: identity.tokenHash,
          host: {
            id: identity.host.id,
            organizationId: identity.host.organization_id,
            principalId: identity.host.principal_id,
            capabilities: identity.host.capabilities,
            slots: identity.host.slots,
            status: identity.host.status,
            desiredMode: identity.host.desired_mode,
            credentialGeneration: identity.host.credential_generation,
            inventoryRevision: identity.host.inventory_revision,
            readinessRevision: identity.host.readiness_revision,
          },
        },
        input: input as never,
        metadata,
        now: new Date(),
      });
    },
  );
  const response = contractSchemas.WorkerInventoryReceipt.parse(
    result.response,
  );
  return jsonResponse(response, 200, result.replayed);
}
