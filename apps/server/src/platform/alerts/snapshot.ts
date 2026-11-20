import type { PgTransactionClient } from "../database.ts";
import type { HealthSnapshot } from "./rules.ts";

/**
 * One round trip that reads how the installation is doing, across every
 * organization: what the alert rules look at. Exported so a test runs the query
 * production runs, not a copy of it.
 *
 * - The oldest event still waiting for delivery, in seconds.
 * - Machines that are meant to be online and have been silent, with how long.
 * - How long the oldest job ready to run has waited.
 * - Open incidents on model routes.
 */
export const HEALTH_SNAPSHOT_SQL = `
select
  coalesce((
    select max(extract(epoch from (now() - next_attempt_at)))
      from bakery.outbox
     where status = 'pending' and next_attempt_at <= now()
  ), 0)::float8 as oldest_event_seconds,
  coalesce((
    select max(extract(epoch from (now() - available_at)))
      from bakery.jobs
     where status = 'queued' and available_at <= now()
  ), 0)::float8 as oldest_job_seconds,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', host.id, 'name', host.name,
      'silent', extract(epoch from (now() - host.last_heartbeat_at))
    ))
      from bakery.worker_hosts host
     where host.archived_at is null and host.status = 'online'
       and host.last_heartbeat_at is not null
  ), '[]'::jsonb) as workers,
  coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', incident.id,
      'route', route.provider || ' ' || route.model,
      'severity', incident.severity
    ))
      from bakery.provider_incidents incident
      join bakery.provider_routes route
        on route.organization_id = incident.organization_id
       and route.id = incident.route_id
     where incident.status = 'open'
  ), '[]'::jsonb) as incidents
`;

type Row = {
  oldest_event_seconds: number | string | null;
  oldest_job_seconds: number | string | null;
  workers: { id: string; name: string; silent: number | string }[] | null;
  incidents: { id: string; route: string; severity: string }[] | null;
};

const seconds = (value: number | string | null | undefined): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

/**
 * Reads the snapshot. `lost` is what telemetry destinations dropped since the
 * last check, which only the running server knows, so the caller supplies it.
 */
export async function readHealthSnapshot(
  database: Pick<PgTransactionClient, "query">,
  lostByDestination: HealthSnapshot["lostByDestination"],
): Promise<HealthSnapshot> {
  const row = (await database.query<Row>(HEALTH_SNAPSHOT_SQL)).rows[0];
  return {
    oldestUndeliveredEventSeconds: seconds(row?.oldest_event_seconds),
    oldestQueuedJobSeconds: seconds(row?.oldest_job_seconds),
    silentWorkers: (row?.workers ?? []).map((worker) => ({
      id: worker.id,
      name: worker.name,
      silentSeconds: seconds(worker.silent),
    })),
    openRouteIncidents: (row?.incidents ?? []).map((incident) => ({
      id: incident.id,
      route: incident.route,
      severity: incident.severity,
    })),
    lostByDestination,
  };
}
