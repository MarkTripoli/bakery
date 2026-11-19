import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import { StandardError } from "@bakery/contracts/http";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../platform/cursor.ts";
import type { PgTransactionClient } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";

/**
 * The provider route, health and incident reads (#26 slice 2).
 *
 * Slice 1 published the five contracts and left them unimplemented on purpose.
 * These are the queries behind them, and they are reads only: nothing here
 * writes a route, moves a circuit state or opens an incident. The monitoring
 * work that does that is a later slice with its own admission rules, so a reader
 * can never mistake this file for the thing that decides an outage.
 *
 * Two shapes matter here and they are easy to confuse:
 *
 * - `health` is the circuit state right now, and it lives on the route as well
 *   as in `provider_route_health`, so a listing needs no join.
 * - `inferenceVerifiedAt` is proof that the inference path works, which a health
 *   probe or a status page never provides. Every read returns it as its own
 *   field and never derives it from `health`, because a route that answers a
 *   reachability check is not a route that can serve paid work.
 */

const ROUTES_ORDERING = "createdAt:desc,id:desc";
const INCIDENTS_ORDERING = "openedAt:desc,id:desc";

export const ROUTE_COLUMNS = `id, provider, endpoint, region, model, harness,
  billing_route, provider_account_id, worker_binding_id, credential_location,
  status, health, incident_id, incident_generation, last_probe_at,
  next_probe_at, inference_verified_at, created_at, updated_at, version`;

const HEALTH_COLUMNS =
  `route_id, health, reason, reason_since, consecutive_failures,
  consecutive_inference_trials, evidence_watermark, last_failure_at,
  last_success_at, last_probe_at, next_probe_at, probe_lease_expires_at,
  corroboration, incident_id, incident_generation, inference_verified_at,
  updated_at`;

const INCIDENT_COLUMNS = `id, route_id, generation, status, severity, reason,
  first_failure_at, last_failure_at, last_probe_at, next_probe_at,
  evidence_watermark, affected_task_count, recovered_task_count,
  switched_task_count, still_blocked_task_count, opened_at, closed_at,
  updated_at, version`;

export type ProviderRouteRow = {
  id: string;
  provider: string;
  endpoint: string;
  region: string | null;
  model: string;
  harness: string;
  billing_route: string;
  provider_account_id: string | null;
  worker_binding_id: string | null;
  credential_location: string;
  status: string;
  health: string;
  incident_id: string | null;
  incident_generation: number;
  last_probe_at: Date | string | null;
  next_probe_at: Date | string | null;
  inference_verified_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
};

type RouteHealthRow = {
  route_id: string;
  health: string;
  reason: string | null;
  reason_since: Date | string | null;
  consecutive_failures: number;
  consecutive_inference_trials: number;
  evidence_watermark: string | null;
  last_failure_at: Date | string | null;
  last_success_at: Date | string | null;
  last_probe_at: Date | string | null;
  next_probe_at: Date | string | null;
  probe_lease_expires_at: Date | string | null;
  corroboration: string;
  incident_id: string | null;
  incident_generation: number;
  inference_verified_at: Date | string | null;
  updated_at: Date | string;
};

type ProviderIncidentRow = {
  id: string;
  route_id: string;
  generation: number;
  status: string;
  severity: string;
  reason: string | null;
  first_failure_at: Date | string;
  last_failure_at: Date | string;
  last_probe_at: Date | string | null;
  next_probe_at: Date | string | null;
  evidence_watermark: string | null;
  affected_task_count: number;
  recovered_task_count: number;
  switched_task_count: number;
  still_blocked_task_count: number;
  opened_at: Date | string;
  closed_at: Date | string | null;
  updated_at: Date | string;
  version: number;
};

/**
 * A timestamp as the contract states it, or null where the column is null.
 *
 * The null case is written out rather than folded into a helper that returns
 * `undefined`: the contract's nullable fields are `null`, and a reader that
 * received `undefined` would see the key vanish from JSON entirely.
 */
function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

export function toProviderRoute(row: ProviderRouteRow) {
  return {
    id: row.id,
    provider: row.provider,
    endpoint: row.endpoint,
    region: row.region,
    model: row.model,
    harness: row.harness as "pi" | "claude_code" | "codex" | "mastra",
    billingRoute: row.billing_route as
      | "subscription"
      | "api_metered"
      | "local",
    providerAccountId: row.provider_account_id,
    workerBindingId: row.worker_binding_id,
    credentialLocation: row.credential_location as
      | "harness_host"
      | "bakery_secret",
    status: row.status as "active" | "disabled" | "revoked",
    health: row.health as "healthy" | "degraded" | "open" | "unverified",
    incidentId: row.incident_id,
    incidentGeneration: row.incident_generation,
    lastProbeAt: toIsoOrNull(row.last_probe_at),
    nextProbeAt: toIsoOrNull(row.next_probe_at),
    inferenceVerifiedAt: toIsoOrNull(row.inference_verified_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

export function toRouteHealth(row: RouteHealthRow) {
  return {
    routeId: row.route_id,
    health: row.health as "healthy" | "degraded" | "open" | "unverified",
    reason: row.reason as
      | "rate_limited"
      | "credential_invalid"
      | "quota_exhausted"
      | "transport_failure"
      | "provider_error"
      | "timeout"
      | "reachable_inference_unverified"
      | "redirected"
      | null,
    reasonSince: toIsoOrNull(row.reason_since),
    consecutiveFailures: row.consecutive_failures,
    consecutiveInferenceTrials: row.consecutive_inference_trials,
    evidenceWatermark: row.evidence_watermark,
    lastFailureAt: toIsoOrNull(row.last_failure_at),
    lastSuccessAt: toIsoOrNull(row.last_success_at),
    lastProbeAt: toIsoOrNull(row.last_probe_at),
    nextProbeAt: toIsoOrNull(row.next_probe_at),
    probeLeaseExpiresAt: toIsoOrNull(row.probe_lease_expires_at),
    corroboration: row.corroboration as "none" | "status_page",
    incidentId: row.incident_id,
    incidentGeneration: row.incident_generation,
    inferenceVerifiedAt: toIsoOrNull(row.inference_verified_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function toProviderIncident(row: ProviderIncidentRow) {
  return {
    id: row.id,
    routeId: row.route_id,
    generation: row.generation,
    status: row.status as "open" | "recovered" | "superseded",
    severity: row.severity as "degraded" | "outage",
    reason: row.reason as
      | "rate_limited"
      | "credential_invalid"
      | "quota_exhausted"
      | "transport_failure"
      | "provider_error"
      | "timeout"
      | "reachable_inference_unverified"
      | null,
    firstFailureAt: toIso(row.first_failure_at),
    lastFailureAt: toIso(row.last_failure_at),
    lastProbeAt: toIsoOrNull(row.last_probe_at),
    nextProbeAt: toIsoOrNull(row.next_probe_at),
    evidenceWatermark: row.evidence_watermark,
    affectedTaskCount: row.affected_task_count,
    recoveredTaskCount: row.recovered_task_count,
    switchedTaskCount: row.switched_task_count,
    stillBlockedTaskCount: row.still_blocked_task_count,
    openedAt: toIso(row.opened_at),
    closedAt: toIsoOrNull(row.closed_at),
    updatedAt: toIso(row.updated_at),
    version: row.version,
  };
}

/**
 * The filters a cursor is bound to.
 *
 * A cursor carries the filters it was issued for, so replaying it under a
 * different `status` is refused rather than quietly returning a page from
 * another question. `JSON.stringify` of a fixed key order is enough here: the
 * binding is compared, not parsed.
 */
function routesFilters(query: { status?: string; health?: string }): string {
  return JSON.stringify({
    status: query.status ?? null,
    health: query.health ?? null,
  });
}

function incidentsFilters(
  query: { routeId?: string; status?: string; severity?: string },
): string {
  return JSON.stringify({
    routeId: query.routeId ?? null,
    status: query.status ?? null,
    severity: query.severity ?? null,
  });
}

function cursorBinding(
  action: string,
  organizationId: string,
  principalId: string,
  ordering: string,
  filters: string,
): CursorBinding {
  return {
    action,
    principalId,
    organizationId,
    ordering,
    filters,
    schemaVersion: 1,
  };
}

/**
 * A page's cursor, taken from the row the query fetched one position beyond it.
 *
 * The timestamp comes from the column the query projected for exactly this
 * purpose (`cursor_created_at` / `cursor_opened_at`), not from the row's own
 * `created_at`: the projection is rendered by `to_char` at microsecond precision
 * so the keyset comparison it is fed back into sees the same value the `order
 * by` saw.
 */
function nextCursorFrom<T>(
  rows: readonly T[],
  limit: number,
  timestampOf: (row: T) => string,
) {
  // `rows` is the whole fetched result, one row longer than the page whenever
  // another page exists. The cursor therefore comes from the last row the caller
  // will actually see, which is the row at `limit - 1`.
  const last = rows.at(limit - 1);
  if (rows.length <= limit || last === undefined) return null;
  return { createdAt: timestampOf(last), id: (last as { id: string }).id };
}

export function createProviderReadHandlers(secret: string) {
  /**
   * GET /v1/provider-routes: the organization's routes, newest first.
   *
   * Revoked and disabled routes are listed, not hidden: a caller asking why work
   * stopped needs to see that the route it was using is revoked. The `status` and
   * `health` filters narrow that set, and both are in the cursor's binding.
   */
  async function listRoutes(
    context: ActionContext,
    input: unknown,
  ): Promise<z.output<typeof contractSchemas["Page<ProviderRoute>"]>> {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const query = input as {
      status?: string;
      health?: string;
      cursor?: string;
      limit?: number;
    };
    const binding = cursorBinding(
      "providerRoutes.list",
      organizationId,
      principalId,
      ROUTES_ORDERING,
      routesFilters(query),
    );
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<
      ProviderRouteRow & { cursor_created_at: string }
    >(
      `select ${ROUTE_COLUMNS},
          to_char(
            created_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_created_at
         from bakery.provider_routes
        where organization_id = $1
          and ($2::text is null or status = $2)
          and ($3::text is null or health = $3)
          and (
            $4::timestamptz is null or (created_at, id) < ($4, $5::uuid)
          )
        order by created_at desc, id desc
        limit $6`,
      [
        organizationId,
        query.status ?? null,
        query.health ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    // The cursor is taken from the page, not from everything fetched: the
    // statement asks for `limit + 1` rows, and the extra one is the proof that a
    // further page exists. Slicing first and then asking whether the slice was
    // short would always say "short".
    const next = nextCursorFrom(
      result.rows,
      limit,
      (row) => row.cursor_created_at,
    );
    const visible = result.rows.slice(0, limit);
    return {
      items: visible.map(toProviderRoute),
      nextCursor: next === null
        ? null
        : await encodeCursor(secret, binding, next),
    };
  }

  /** GET /v1/provider-routes/{id}: one route, or absent. */
  async function getRoute(
    context: ActionContext,
    input: unknown,
  ): Promise<z.output<typeof contractSchemas.ProviderRoute>> {
    void input;
    const { transaction, organizationId } = requireWorkTransaction(context);
    const routeId = context.params.id;
    if (!routeId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const result = await transaction.query<ProviderRouteRow>(
      `select ${ROUTE_COLUMNS}
         from bakery.provider_routes
        where organization_id = $1 and id = $2`,
      [organizationId, routeId],
    );
    const row = result.rows[0];
    if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return toProviderRoute(row);
  }

  /**
   * GET /v1/provider-routes/{id}/health: the monitoring view of one route.
   *
   * A route with no health row yet answers `unverified` rather than 404: the
   * route exists and nothing has judged it, and a 404 would tell a caller the
   * route was missing. The zeros are the honest state before any probe.
   */
  async function getRouteHealth(
    context: ActionContext,
    input: unknown,
  ): Promise<z.output<typeof contractSchemas.RouteHealth>> {
    void input;
    const { transaction, organizationId } = requireWorkTransaction(context);
    const routeId = context.params.id;
    if (!routeId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const result = await transaction.query<RouteHealthRow>(
      `select ${HEALTH_COLUMNS}
         from bakery.provider_route_health
        where organization_id = $1 and route_id = $2`,
      [organizationId, routeId],
    );
    const row = result.rows[0];
    if (row) return toRouteHealth(row);

    // No health row yet. The route row carries the same projection - the
    // contract says so, which is why a listing needs no join - so the answer
    // comes from there rather than from a fabricated row. A route that does not
    // exist is still absent; the two cases are different questions.
    const route = await transaction.query<
      { id: string; health: string; updated_at: Date | string }
    >(
      `select id, health, updated_at from bakery.provider_routes
        where organization_id = $1 and id = $2`,
      [organizationId, routeId],
    );
    const existing = route.rows[0];
    if (!existing) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return {
      routeId: existing.id,
      health: existing.health as
        | "healthy"
        | "degraded"
        | "open"
        | "unverified",
      reason: null,
      reasonSince: null,
      consecutiveFailures: 0,
      consecutiveInferenceTrials: 0,
      evidenceWatermark: null,
      lastFailureAt: null,
      lastSuccessAt: null,
      lastProbeAt: null,
      nextProbeAt: null,
      probeLeaseExpiresAt: null,
      corroboration: "none" as const,
      incidentId: null,
      incidentGeneration: 0,
      inferenceVerifiedAt: null,
      // Non-null in the contract: the projection exists as soon as the route
      // does, and the route's own timestamp is when it last changed.
      updatedAt: toIso(existing.updated_at),
    };
  }

  /**
   * GET /v1/provider-incidents: incidents across the organization, newest first.
   *
   * The three filters are independent, so an operator can ask "every outage" or
   * "everything open on this route" without a second endpoint. Each is in the
   * cursor's binding, so a page cannot be continued under a different question.
   */
  async function listIncidents(
    context: ActionContext,
    input: unknown,
  ): Promise<z.output<typeof contractSchemas["Page<ProviderIncident>"]>> {
    const { transaction, organizationId, principalId } = requireWorkTransaction(
      context,
    );
    const query = input as {
      routeId?: string;
      status?: string;
      severity?: string;
      cursor?: string;
      limit?: number;
    };
    const binding = cursorBinding(
      "providerIncidents.list",
      organizationId,
      principalId,
      INCIDENTS_ORDERING,
      incidentsFilters(query),
    );
    const position = await decodeCursor(secret, query.cursor, binding);
    const limit = query.limit ?? 25;
    const result = await transaction.query<
      ProviderIncidentRow & { cursor_opened_at: string }
    >(
      `select ${INCIDENT_COLUMNS},
          to_char(
            opened_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) as cursor_opened_at
         from bakery.provider_incidents
        where organization_id = $1
          and ($2::uuid is null or route_id = $2)
          and ($3::text is null or status = $3)
          and ($4::text is null or severity = $4)
          and (
            $5::timestamptz is null or (opened_at, id) < ($5, $6::uuid)
          )
        order by opened_at desc, id desc
        limit $7`,
      [
        organizationId,
        query.routeId ?? null,
        query.status ?? null,
        query.severity ?? null,
        position?.createdAt ?? null,
        position?.id ?? null,
        limit + 1,
      ],
    );
    // Same rule as the route list: the extra row is what says the page
    // continues, so it is read before the slice discards it.
    const next = nextCursorFrom(
      result.rows,
      limit,
      (row) => row.cursor_opened_at,
    );
    const visible = result.rows.slice(0, limit);
    return {
      items: visible.map(toProviderIncident),
      nextCursor: next === null
        ? null
        : await encodeCursor(secret, binding, next),
    };
  }

  /** GET /v1/provider-incidents/{id}: one incident, or absent. */
  async function getIncident(
    context: ActionContext,
    input: unknown,
  ): Promise<z.output<typeof contractSchemas.ProviderIncident>> {
    void input;
    const { transaction, organizationId } = requireWorkTransaction(context);
    const incidentId = context.params.id;
    if (!incidentId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    const result = await transaction.query<ProviderIncidentRow>(
      `select ${INCIDENT_COLUMNS}
         from bakery.provider_incidents
        where organization_id = $1 and id = $2`,
      [organizationId, incidentId],
    );
    const row = result.rows[0];
    if (!row) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
    return toProviderIncident(row);
  }

  return {
    listRoutes,
    getRoute,
    getRouteHealth,
    listIncidents,
    getIncident,
  };
}

/**
 * The transaction a read runs in.
 *
 * Re-exported so the handler signatures read without importing the work module
 * twice, and so a test can build the same shape.
 */
export type { PgTransactionClient };
