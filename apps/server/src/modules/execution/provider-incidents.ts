import type { PgTransactionClient } from "../../platform/database.ts";

/**
 * Records one probe result against a provider route and moves its incident
 * (#26 slice 2, writes).
 *
 * This is the only writer of a route's circuit state and of an incident. It has
 * no HTTP operation: nothing a caller says opens or closes an incident. The host
 * does, after judging evidence, and the evidence it hands in is this function's
 * whole input.
 *
 * ## The generation fence (AC1)
 *
 * A probe carries the `generation` it was admitted under, which is the route's
 * `incident_generation` when the monitor read it. A result whose generation is
 * not the route's current one is stale and changes nothing: it cannot open an
 * incident a newer probe already opened, cannot close one it predates, and cannot
 * move health. The route row is locked first, so two probes of one route cannot
 * both pass the check against the same generation.
 *
 * Opening takes generation N to N+1, so the incident line is monotonic and an
 * incident keeps the number it opened with. A probe that finds the route at N+1
 * and reports a failure is therefore a result about the incident, not a second
 * outage.
 *
 * ## Reachable is not recovered (AC2)
 *
 * Three outcomes, and only one of them closes an incident:
 *
 * - `failure` opens an incident, or marks the open one as still failing.
 * - `reachable` records that the endpoint answered. The incident stays open and
 *   the reason becomes `reachable_inference_unverified`: an answered health read
 *   is not proof that paid work will run.
 * - `inference_proven` is the result of an already-authorized request that
 *   really ran. It is the only outcome that closes an incident, and it is the
 *   only one that sets `inference_verified_at`. Deciding that two such trials in
 *   a row are required, and releasing waiting work, belong to later slices.
 *
 * ## Duplicates
 *
 * Every outcome names the evidence it was judged from. The same watermark applied
 * twice is a duplicate and writes nothing, so a retried probe counts one failure
 * however many times it arrives.
 */

export type IncidentReason =
  | "rate_limited"
  | "credential_invalid"
  | "quota_exhausted"
  | "transport_failure"
  | "provider_error"
  | "timeout"
  | "reachable_inference_unverified";

export type ProbeOutcome =
  | {
    kind: "failure";
    reason: Exclude<IncidentReason, "reachable_inference_unverified">;
    severity: "degraded" | "outage";
    /** Opaque bounded reference to the evidence; never a credential or provider output. */
    evidenceWatermark: string;
  }
  | { kind: "reachable"; evidenceWatermark: string }
  /**
   * The endpoint answered with a redirect, which the probe does not follow. It
   * proves nothing: not reachable (the real endpoint was never asked) and not a
   * failure (the host did answer). The route reads `unverified` with the reason
   * `redirected` until a probe proves it reachable again; no failure is counted
   * and no incident is touched.
   */
  | { kind: "redirected"; evidenceWatermark: string }
  | { kind: "inference_proven"; evidenceWatermark: string };

export type ProbeResult =
  | { kind: "opened"; incidentId: string; generation: number }
  | { kind: "updated"; incidentId: string | null; generation: number }
  | { kind: "recovered"; incidentId: string; generation: number }
  | { kind: "duplicate"; generation: number }
  | { kind: "stale"; currentGeneration: number }
  | { kind: "ignored"; reason: "unknown_route" | "route_not_active" };

type RouteState = {
  status: string;
  health: string;
  incident_id: string | null;
  incident_generation: number;
  inference_verified_at: Date | string | null;
};

type HealthState = {
  evidence_watermark: string | null;
  consecutive_failures: number;
};

type IncidentState = { id: string; generation: number; severity: string };

export async function recordProbeResult(
  transaction: PgTransactionClient,
  probe: {
    organizationId: string;
    routeId: string;
    /** The route's incident generation when the monitor admitted the probe. */
    generation: number;
    observedAt: Date;
    /**
     * When the route is next probed, or `null` to stop probing it. The caller owns
     * the schedule (backoff, `Retry-After`, a steady interval) because it is what
     * saw the response; this function only records it, on the route, its health row
     * and its open incident, so the three never disagree.
     */
    nextProbeAt: Date | null;
    /**
     * Whether a failure may open or extend an incident.
     *
     * `off` records the failure as an observation only: the route's health row
     * counts it and says why, and the schedule moves, but no incident is opened and
     * the route's circuit state is not touched. The probe runs with it off until the
     * inference-trial slice, because an incident is only safe to open once something
     * can close it: a transient outage must never permanently remove a route. That
     * slice turns this on together with its closer.
     */
    incidents: "off" | "on";
    outcome: ProbeOutcome;
  },
): Promise<ProbeResult> {
  const { organizationId, routeId, outcome } = probe;
  const route = (await transaction.query<RouteState>(
    `select status, health, incident_id, incident_generation,
            inference_verified_at
       from bakery.provider_routes
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, routeId],
  )).rows[0];
  if (!route) return { kind: "ignored", reason: "unknown_route" };
  // A disabled or revoked route is never probed, so a result that arrives for one
  // was admitted before it was withdrawn and must not revive it.
  if (route.status !== "active") {
    return { kind: "ignored", reason: "route_not_active" };
  }
  if (probe.generation !== route.incident_generation) {
    return { kind: "stale", currentGeneration: route.incident_generation };
  }

  const health = (await transaction.query<HealthState>(
    `select evidence_watermark, consecutive_failures
       from bakery.provider_route_health
      where organization_id = $1 and route_id = $2
        for update`,
    [organizationId, routeId],
  )).rows[0];
  if (health?.evidence_watermark === outcome.evidenceWatermark) {
    return { kind: "duplicate", generation: route.incident_generation };
  }

  // A redirect proves nothing and touches no incident, so it is settled before
  // any incident is read or locked.
  if (outcome.kind === "redirected") {
    return await recordRedirected(transaction, probe, route);
  }

  const open = route.incident_id === null ? undefined : (await transaction
    .query<IncidentState>(
      `select id, generation, severity
         from bakery.provider_incidents
        where organization_id = $1 and id = $2 and status = 'open'
          for update`,
      [organizationId, route.incident_id],
    )).rows[0];

  if (outcome.kind === "failure" && probe.incidents === "off") {
    return await recordFailureObservation(transaction, probe, route, health);
  }
  if (outcome.kind === "failure") {
    return open === undefined
      ? await openIncident(transaction, probe, route, health)
      : await extendIncident(transaction, probe, route, health, open);
  }
  if (outcome.kind === "reachable") {
    return await recordReachable(transaction, probe, route, open);
  }

  return await recordInferenceProven(transaction, probe, route, open);
}

/** Health a route shows for a failure of this severity. */
const healthFor = (severity: "degraded" | "outage") =>
  severity === "outage" ? "open" : "degraded";

/**
 * A failure recorded without an incident: counted and explained on the health row,
 * scheduled for a retry, and nothing else. The route keeps whatever circuit state
 * and incident it had, so an unreachable probe cannot take a route out of service.
 */
async function recordFailureObservation(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  route: RouteState,
  health: HealthState | undefined,
): Promise<ProbeResult> {
  const outcome = probe.outcome as Extract<ProbeOutcome, { kind: "failure" }>;
  await writeRoute(transaction, probe, {
    health: route.health,
    incidentId: route.incident_id,
    incidentGeneration: route.incident_generation,
    inferenceVerifiedAt: undefined,
  });
  await upsertHealth(transaction, probe, {
    health: route.health,
    reason: outcome.reason,
    consecutiveFailures: (health?.consecutive_failures ?? 0) + 1,
    incidentId: route.incident_id,
    incidentGeneration: route.incident_generation,
    failedAt: probe.observedAt,
    succeededAt: undefined,
  });
  return {
    kind: "updated",
    incidentId: route.incident_id,
    generation: route.incident_generation,
  };
}

async function openIncident(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  route: RouteState,
  health: HealthState | undefined,
): Promise<ProbeResult> {
  const { organizationId, routeId, observedAt } = probe;
  const outcome = probe.outcome as Extract<ProbeOutcome, { kind: "failure" }>;
  const generation = route.incident_generation + 1;
  const incidentId = crypto.randomUUID();
  await transaction.query(
    `insert into bakery.provider_incidents (
       id, organization_id, route_id, generation, status, severity, reason,
       first_failure_at, last_failure_at, last_probe_at, evidence_watermark,
       opened_at, next_probe_at
     ) values ($1, $2, $3, $4, 'open', $5, $6, $7, $7, $7, $8, $7, $9)`,
    [
      incidentId,
      organizationId,
      routeId,
      generation,
      outcome.severity,
      outcome.reason,
      observedAt,
      outcome.evidenceWatermark,
      probe.nextProbeAt,
    ],
  );
  await writeRoute(transaction, probe, {
    health: healthFor(outcome.severity),
    incidentId,
    incidentGeneration: generation,
    inferenceVerifiedAt: undefined,
  });
  await upsertHealth(transaction, probe, {
    health: healthFor(outcome.severity),
    reason: outcome.reason,
    consecutiveFailures: (health?.consecutive_failures ?? 0) + 1,
    incidentId,
    incidentGeneration: generation,
    failedAt: observedAt,
    succeededAt: undefined,
  });
  return { kind: "opened", incidentId, generation };
}

async function extendIncident(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  route: RouteState,
  health: HealthState | undefined,
  open: IncidentState,
): Promise<ProbeResult> {
  const { organizationId, observedAt } = probe;
  const outcome = probe.outcome as Extract<ProbeOutcome, { kind: "failure" }>;
  // An incident escalates from degraded to outage and never the other way: a
  // quieter probe is not evidence the outage ended, only a proven inference is.
  const severity = open.severity === "outage" ? "outage" : outcome.severity;
  await transaction.query(
    `update bakery.provider_incidents
        set severity = $3, reason = $4, last_failure_at = $5,
            last_probe_at = $5, evidence_watermark = $6, next_probe_at = $7,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [
      organizationId,
      open.id,
      severity,
      outcome.reason,
      observedAt,
      outcome.evidenceWatermark,
      probe.nextProbeAt,
    ],
  );
  await writeRoute(transaction, probe, {
    health: healthFor(severity as "degraded" | "outage"),
    incidentId: open.id,
    incidentGeneration: route.incident_generation,
    inferenceVerifiedAt: undefined,
  });
  await upsertHealth(transaction, probe, {
    health: healthFor(severity as "degraded" | "outage"),
    reason: outcome.reason,
    consecutiveFailures: (health?.consecutive_failures ?? 0) + 1,
    incidentId: open.id,
    incidentGeneration: route.incident_generation,
    failedAt: observedAt,
    succeededAt: undefined,
  });
  return {
    kind: "updated",
    incidentId: open.id,
    generation: route.incident_generation,
  };
}

/**
 * A redirect: it proves nothing, and a route must not keep looking healthy on it.
 *
 * The route's health reads `unverified`, with `redirected` as the reason and the
 * time that reason began, until a probe proves the endpoint reachable again. It is
 * neither counted as a failure (the host did answer) nor credited as reachable
 * (the real endpoint was never asked), so the failure count, the last-success
 * time, the incident and the inference proof are left exactly as they were. A
 * route with an open incident keeps that state: the incident is the stronger
 * statement and a redirect does not soften it.
 */
async function recordRedirected(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  route: RouteState,
): Promise<ProbeResult> {
  const health = route.incident_id === null ? "unverified" : route.health;
  await transaction.query(
    `update bakery.provider_routes
        set health = $3, last_probe_at = $4, next_probe_at = $5,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [
      probe.organizationId,
      probe.routeId,
      health,
      probe.observedAt,
      probe.nextProbeAt,
    ],
  );
  await transaction.query(
    `insert into bakery.provider_route_health (
       organization_id, route_id, health, reason, reason_since,
       evidence_watermark, last_probe_at, next_probe_at, probe_lease_expires_at,
       incident_id, incident_generation
     ) values ($1, $2, $3, 'redirected', $5, $4, $5, $6, null, $7, $8)
     on conflict (organization_id, route_id) do update
       set health = excluded.health,
           reason_since = case
             when bakery.provider_route_health.reason is distinct from 'redirected'
               then excluded.last_probe_at
             else bakery.provider_route_health.reason_since end,
           reason = 'redirected',
           evidence_watermark = excluded.evidence_watermark,
           last_probe_at = excluded.last_probe_at,
           next_probe_at = excluded.next_probe_at,
           probe_lease_expires_at = null,
           updated_at = now()`,
    [
      probe.organizationId,
      probe.routeId,
      health,
      probe.outcome.evidenceWatermark,
      probe.observedAt,
      probe.nextProbeAt,
      route.incident_id,
      route.incident_generation,
    ],
  );
  return {
    kind: "updated",
    incidentId: route.incident_id,
    generation: route.incident_generation,
  };
}

async function recordReachable(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  route: RouteState,
  open: IncidentState | undefined,
): Promise<ProbeResult> {
  const { organizationId, observedAt } = probe;
  if (open !== undefined) {
    // The incident stays open: the endpoint answered, nothing more.
    await transaction.query(
      `update bakery.provider_incidents
          set last_probe_at = $3, evidence_watermark = $4, next_probe_at = $5,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [
        organizationId,
        open.id,
        observedAt,
        probe.outcome.evidenceWatermark,
        probe.nextProbeAt,
      ],
    );
  }
  // A redirect left the route `unverified` (see `recordRedirected`). A route that
  // had proven inference before, and has no incident, returns to what it was once
  // the endpoint answers for itself again; one that never proved inference stays
  // unverified, because reachable proves nothing about that.
  const health = open === undefined && route.health === "unverified" &&
      route.inference_verified_at !== null
    ? "healthy"
    : route.health;
  await writeRoute(transaction, probe, {
    health,
    incidentId: open?.id ?? null,
    incidentGeneration: route.incident_generation,
    inferenceVerifiedAt: undefined,
  });
  await upsertHealth(transaction, probe, {
    health,
    reason: open === undefined ? null : "reachable_inference_unverified",
    consecutiveFailures: 0,
    incidentId: open?.id ?? null,
    incidentGeneration: route.incident_generation,
    failedAt: undefined,
    succeededAt: observedAt,
  });
  return {
    kind: "updated",
    incidentId: open?.id ?? null,
    generation: route.incident_generation,
  };
}

async function recordInferenceProven(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  route: RouteState,
  open: IncidentState | undefined,
): Promise<ProbeResult> {
  const { organizationId, observedAt } = probe;
  if (open !== undefined) {
    await transaction.query(
      `update bakery.provider_incidents
          set status = 'recovered', closed_at = $3, last_probe_at = $3,
              evidence_watermark = $4, next_probe_at = null,
              updated_at = now(), version = version + 1
        where organization_id = $1 and id = $2`,
      [organizationId, open.id, observedAt, probe.outcome.evidenceWatermark],
    );
  }
  await writeRoute(transaction, probe, {
    health: "healthy",
    incidentId: null,
    incidentGeneration: route.incident_generation,
    inferenceVerifiedAt: observedAt,
  });
  await upsertHealth(transaction, probe, {
    health: "healthy",
    reason: null,
    consecutiveFailures: 0,
    incidentId: null,
    incidentGeneration: route.incident_generation,
    failedAt: undefined,
    succeededAt: observedAt,
    inferenceVerifiedAt: observedAt,
  });
  return open === undefined
    ? {
      kind: "updated",
      incidentId: null,
      generation: route.incident_generation,
    }
    : {
      kind: "recovered",
      incidentId: open.id,
      generation: route.incident_generation,
    };
}

/** The route's own projection of its circuit state, so a listing needs no join. */
async function writeRoute(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  next: {
    health: string;
    incidentId: string | null;
    incidentGeneration: number;
    inferenceVerifiedAt: Date | undefined;
  },
): Promise<void> {
  await transaction.query(
    `update bakery.provider_routes
        set health = $3, incident_id = $4, incident_generation = $5,
            last_probe_at = $6, next_probe_at = $9,
            inference_verified_at = case when $7::boolean then $8::timestamptz
                                         else inference_verified_at end,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [
      probe.organizationId,
      probe.routeId,
      next.health,
      next.incidentId,
      next.incidentGeneration,
      probe.observedAt,
      next.inferenceVerifiedAt !== undefined,
      next.inferenceVerifiedAt ?? null,
      probe.nextProbeAt,
    ],
  );
}

/** One health row per route, keyed by the route: a second writer updates it, never adds a second opinion. */
async function upsertHealth(
  transaction: PgTransactionClient,
  probe: Parameters<typeof recordProbeResult>[1],
  next: {
    health: string;
    reason: string | null;
    consecutiveFailures: number;
    incidentId: string | null;
    incidentGeneration: number;
    failedAt: Date | undefined;
    succeededAt: Date | undefined;
    inferenceVerifiedAt?: Date;
  },
): Promise<void> {
  await transaction.query(
    `insert into bakery.provider_route_health (
       organization_id, route_id, health, reason, consecutive_failures,
       evidence_watermark, last_failure_at, last_success_at, last_probe_at,
       probe_lease_expires_at, incident_id, incident_generation,
       inference_verified_at, next_probe_at, reason_since
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, null, $10, $11, $12, $13,
       case when $4::text is null then null else $9::timestamptz end)
     on conflict (organization_id, route_id) do update
       set health = excluded.health,
           reason_since = case
             when excluded.reason is null then null
             when bakery.provider_route_health.reason is distinct from excluded.reason
               then excluded.last_probe_at
             else bakery.provider_route_health.reason_since end,
           reason = excluded.reason,
           consecutive_failures = excluded.consecutive_failures,
           evidence_watermark = excluded.evidence_watermark,
           last_failure_at = coalesce(
             excluded.last_failure_at,
             bakery.provider_route_health.last_failure_at),
           last_success_at = coalesce(
             excluded.last_success_at,
             bakery.provider_route_health.last_success_at),
           last_probe_at = excluded.last_probe_at,
           next_probe_at = excluded.next_probe_at,
           probe_lease_expires_at = null,
           incident_id = excluded.incident_id,
           incident_generation = excluded.incident_generation,
           inference_verified_at = coalesce(
             excluded.inference_verified_at,
             bakery.provider_route_health.inference_verified_at),
           updated_at = now()`,
    [
      probe.organizationId,
      probe.routeId,
      next.health,
      next.reason,
      next.consecutiveFailures,
      probe.outcome.evidenceWatermark,
      next.failedAt ?? null,
      next.succeededAt ?? null,
      probe.observedAt,
      next.incidentId,
      next.incidentGeneration,
      next.inferenceVerifiedAt ?? null,
      probe.nextProbeAt,
    ],
  );
}
