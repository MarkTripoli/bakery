import type { ActionContext } from "@bakery/contracts/action-registry";
import {
  contractSchemas,
  type OrganizationId,
  organizationId as asOrganizationId,
  type PrincipalId,
  principalId as asPrincipalId,
} from "@bakery/contracts/contracts";
import { z } from "zod";
import { StandardError } from "@bakery/contracts/http";
import type { JsonValue } from "@bakery/contracts/contracts";
import {
  type CursorBinding,
  decodeSequenceCursor,
  encodeSequenceCursor,
} from "../../platform/cursor.ts";
import {
  assertScope,
  EVENT_SCOPES,
  isOutsideRetention,
  readEventClock,
  readScopedEvents,
  toEvent,
} from "./event-stream.ts";
import type { SyncScope } from "./event-stream.ts";
import { resourceState } from "./sync-snapshot.ts";
import { requireWorkTransaction } from "./work-transaction.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import {
  connectivityState,
  evaluateReadiness,
} from "@bakery/persistence/machine-readiness";

/**
 * Worker scopes project the machine's safe status instead of tasks: a
 * no-cursor snapshot over worker_enrollment returns the server-confirmed
 * EnrollmentStatus (the true machine after any register/cancel race), a
 * worker scope returns the safe WorkerHost projection.
 */
async function resourceStateForScope(
  transaction: PgTransactionClient,
  organizationId: OrganizationId,
  scope: SyncScope,
): Promise<JsonValue> {
  if (
    scope.type !== "worker_enrollment" && scope.type !== "worker"
  ) {
    return await resourceState(
      transaction,
      organizationId,
      scope.id,
      EVENT_SCOPES[scope.type].taskColumn,
    );
  }
  const workerScope = scope.type === "worker";
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
  }>(
    `select h.id, h.organization_id, h.principal_id, h.name, h.os,
            h.architecture, h.capabilities, h.toolchain_versions, h.slots,
            h.status, h.desired_mode, h.last_heartbeat_at,
            h.credential_generation, h.inventory_revision,
            h.created_at, h.updated_at, h.version
     from bakery.worker_hosts h
     ${
      workerScope
        ? "where h.organization_id = $1 and h.id = $2"
        : `where h.organization_id = $1 and h.id = (
             select worker_host_id from bakery.worker_enrollments
              where organization_id = $1 and id = $2 and consumed_at is not null)`
    }`,
    [organizationId, scope.id],
  );
  const host = result.rows[0];
  if (!host) return {};
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
  const now = new Date();
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
  const safeWorker = {
    id: host.id,
    principalId: host.principal_id,
    name: host.name,
    os: host.os,
    architecture: host.architecture,
    capabilities: host.capabilities as JsonValue,
    toolchainVersions: host.toolchain_versions as JsonValue,
    slots: host.slots,
    status: host.status,
    desiredMode: host.desired_mode,
    connectivity,
    readiness: readiness.state,
    readinessReason: readiness.reason,
    failedCheckIds: readiness.failedCheckIds,
    lastHeartbeatAt: host.last_heartbeat_at
      ? host.last_heartbeat_at.toISOString()
      : null,
    credentialGeneration: host.credential_generation,
    createdAt: host.created_at.toISOString(),
    updatedAt: host.updated_at.toISOString(),
    version: host.version,
  };
  return workerScope ? { worker: safeWorker } : { enrollment: safeWorker };
}

const EVENT_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 100;
const SYNC_ORDERING = "sequence:asc";
const SYNC_SCHEMA_VERSION = 1;

type SyncQuery = z.output<typeof contractSchemas.SyncQuery>;

function scopeValue(query: SyncQuery): SyncScope {
  return Object.freeze({ type: query.scopeType, id: query.scopeId });
}

function binding(
  principalId: PrincipalId,
  organizationId: OrganizationId,
  scope: SyncScope,
): CursorBinding {
  return {
    action: "sync.snapshot",
    principalId,
    organizationId,
    ordering: SYNC_ORDERING,
    filters: JSON.stringify({
      scopeId: scope.id,
      scopeType: scope.type,
    }),
    schemaVersion: SYNC_SCHEMA_VERSION,
  };
}

export function createSyncQueryHandler(secret: string) {
  return async (context: ActionContext, input: unknown) => {
    const {
      transaction,
      organizationId: rawOrganizationId,
      principalId: rawPrincipalId,
    } = requireWorkTransaction(context);
    const organizationId = asOrganizationId(rawOrganizationId);
    const principalId = asPrincipalId(rawPrincipalId);
    const query = input as SyncQuery;
    const scope = scopeValue(query);
    await assertScope(transaction, organizationId, scope);
    const cursorBinding = binding(principalId, organizationId, scope);
    const position = await decodeSequenceCursor(
      secret,
      query.after,
      cursorBinding,
    );
    const current = await readEventClock(transaction, organizationId);
    if (
      position !== null &&
      isOutsideRetention(BigInt(position.sequence), current)
    ) {
      throw new StandardError({
        code: "STATE_CONFLICT",
        params: {
          resetRequired: true,
          retainedFrom: current.retainedFrom,
          retryWithoutAfter: true,
        },
      });
    }
    const includeSnapshot = position === null;
    const limit = Math.min(
      Number(query.limit ?? DEFAULT_EVENT_LIMIT),
      EVENT_LIMIT,
    );
    const events = includeSnapshot ? [] : await readScopedEvents(
      transaction,
      organizationId,
      [scope],
      position!.sequence,
      current.highwater,
      limit + 1,
    );
    const visibleEvents = events.slice(0, limit);
    const hasContinuation = events.length > limit;
    const caughtUp = position !== null &&
      BigInt(position.sequence) === BigInt(current.highwater);
    const checkpointSequence = hasContinuation
      ? visibleEvents.at(-1)?.sequence ?? current.highwater
      : current.highwater;
    return {
      resourceState: includeSnapshot
        ? await resourceStateForScope(transaction, organizationId, scope)
        : {},
      highwater: current.highwater,
      events: visibleEvents.map(toEvent),
      nextCursor: includeSnapshot || hasContinuation || !caughtUp
        ? await encodeSequenceCursor(secret, cursorBinding, {
          sequence: checkpointSequence,
        })
        : null,
      resetRequired: false,
    };
  };
}
