import type {
  PgDatabase,
  PgTransactionClient,
} from "../../../platform/database.ts";
import { appendDomainEvent } from "@bakery/persistence/event-audit";
import { sha256Hex } from "../../../platform/canonical-json.ts";
import {
  type CursorBinding,
  decodeCursor,
  encodeCursor,
} from "../../../platform/cursor.ts";
import { PREVIEW_GRANT_TTL_SECONDS, randomPreviewSecret } from "./shared.ts";

/** A running-app preview stops by itself this long after it registers. */
export const RUNNING_PREVIEW_LIFETIME_SECONDS = 4 * 60 * 60;

/** Route keys are lowercase letters, digits and hyphens: never a host or path. */
export const ROUTE_KEY_PATTERN = /^[a-z0-9](?:[a-z0-9-]{6,62})[a-z0-9]$/;

export type PreviewStopReason =
  | "person"
  | "run_cancelled"
  | "run_ended"
  | "machine_lost"
  | "time_limit"
  | "replaced";

export type PreviewStatus = "starting" | "ready" | "stopped" | "expired";

export type PreviewView = {
  id: string;
  runId: string;
  attemptId: string;
  headSha: string;
  status: PreviewStatus;
  stopReason: PreviewStopReason | null;
  stoppedBy: string | null;
  stoppedByName: string | null;
  stoppedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  version: number;
};

type PreviewRow = {
  id: string;
  run_id: string;
  attempt_id: string;
  head_sha: string;
  status: PreviewStatus;
  stop_reason: PreviewStopReason | null;
  stopped_by: string | null;
  stopped_by_name: string | null;
  stopped_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  version: number;
};

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const iso = (column: string) => `to_char(${column} at time zone 'UTC', ${ISO})`;

/**
 * What a preview is NOW, decided on every read from the preview row and the
 * attempt that registered it, so a dead preview is never shown as running and
 * nothing depends on a sweep having run. A person's stop wins, then the time
 * limit, then the run being cancelled, a newer attempt, the machine's lease,
 * and the attempt having ended.
 */
export const STATE = `
  case
    when p.status in ('stopped', 'expired') then p.status
    when p.expires_at <= now() then 'expired'
    when a.status = 'canceled' or j.cancel_requested_at is not null
      or a.fence <> j.current_fence
      or a.status in ('lost', 'completed', 'failed', 'quarantined')
      or a.lease_expires_at <= now() then 'stopped'
    else p.status
  end`;

const STOP_REASON = `
  case
    when p.status in ('stopped', 'expired') then p.stop_reason
    when p.expires_at <= now() then 'time_limit'
    when a.status = 'canceled' or j.cancel_requested_at is not null
      then 'run_cancelled'
    when a.fence <> j.current_fence then 'replaced'
    when a.status in ('completed', 'failed') then 'run_ended'
    when a.status in ('lost', 'quarantined') or a.lease_expires_at <= now()
      then 'machine_lost'
    else null
  end`;

const STOPPED_AT = `
  case
    when p.status in ('stopped', 'expired') then p.stopped_at
    when p.expires_at <= now() then p.expires_at
    when a.status = 'canceled' or j.cancel_requested_at is not null
      then coalesce(j.cancel_requested_at, a.ended_at, p.updated_at)
    when a.fence <> j.current_fence then p.updated_at
    when a.status in ('completed', 'failed') then coalesce(a.ended_at, p.updated_at)
    when a.status in ('lost', 'quarantined') or a.lease_expires_at <= now()
      then coalesce(a.ended_at, a.lease_expires_at)
    else null
  end`;

/** Never selects the route key or the port: they stay on the server. */
const PREVIEW_COLUMNS = `
  p.id, p.run_id, p.attempt_id, p.head_sha,
  ${STATE} as status,
  ${STOP_REASON} as stop_reason,
  p.stopped_by, who.display_name as stopped_by_name,
  ${iso(`(${STOPPED_AT})`)} as stopped_at,
  ${iso("p.expires_at")} as expires_at,
  ${iso("p.created_at")} as created_at,
  ${iso("p.updated_at")} as updated_at,
  p.version`;

export const PREVIEW_FROM = `
  from bakery.previews p
  join bakery.job_attempts a
    on a.organization_id = p.organization_id and a.id = p.attempt_id
  join bakery.jobs j
    on j.organization_id = a.organization_id and j.id = a.job_id
  left join bakery.principals who on who.id = p.stopped_by`;

function toPreview(row: PreviewRow): PreviewView {
  return {
    id: row.id,
    runId: row.run_id,
    attemptId: row.attempt_id,
    headSha: row.head_sha,
    status: row.status,
    stopReason: row.stop_reason,
    // Only a person's stop names a person.
    stoppedBy: row.stop_reason === "person" ? row.stopped_by : null,
    stoppedByName: row.stop_reason === "person" ? row.stopped_by_name : null,
    stoppedAt: row.stopped_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

export async function readPreview(
  transaction: PgTransactionClient,
  organizationId: string,
  previewId: string,
): Promise<PreviewView | null> {
  const result = await transaction.query<PreviewRow>(
    `select ${PREVIEW_COLUMNS} ${PREVIEW_FROM}
      where p.organization_id = $1 and p.id = $2`,
    [organizationId, previewId],
  );
  return result.rows[0] ? toPreview(result.rows[0]) : null;
}

/**
 * Tells everyone watching the run's task that a preview changed, so an open
 * task page re-reads it. The event carries no state: the page fetches the
 * preview through its own authorized read. Only changes a writer makes send
 * one; a preview that ends by itself is derived when it is read.
 */
async function announcePreview(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    previewId: string;
    runId: string;
    version: number;
    eventType: "preview.ready" | "preview.stopped";
    /** The trace of the request that caused the change, so the event joins it. */
    traceId: string;
  },
): Promise<void> {
  const run = await transaction.query<{ task_id: string }>(
    `select task_id from bakery.workflow_runs
      where organization_id = $1 and id = $2`,
    [input.organizationId, input.runId],
  );
  const taskId = run.rows[0]?.task_id;
  if (taskId === undefined) return;
  await appendDomainEvent(transaction, {
    organizationId: input.organizationId,
    taskId,
    eventType: input.eventType,
    aggregateId: input.previewId,
    aggregateVersion: input.version,
    payload: { resourceId: input.previewId, resourceVersion: input.version },
    traceId: input.traceId,
  });
}

export type RegisterPreviewInput = {
  organizationId: string;
  attemptId: string;
  routeKey: string;
  upstreamPort: number;
  headSha: string;
  /** Trace of the registering request; the preview.ready event carries it. */
  traceId: string;
};

export type RegisteredPreview =
  | { kind: "created" | "replayed"; preview: PreviewView }
  | { kind: "conflict" };

/**
 * Registers the preview of the attempt the caller has already proved it holds
 * (lease, fence, session). A newer attempt's registration stops the older
 * attempts' live previews of the same JOB in the same statement chain, so one
 * job never has live previews from two attempts at once. Previews are replaced
 * per job, not per run: a run with several jobs keeps each job's preview, and
 * one attempt may register more than one app (one route key each). Repeating
 * the same registration is a replay; the same route key for anything else is a
 * conflict.
 */
export async function registerPreview(
  transaction: PgTransactionClient,
  input: RegisterPreviewInput,
): Promise<RegisteredPreview> {
  const attempt = await transaction.query<{ run_id: string; job_id: string }>(
    `select wr.id as run_id, j.id as job_id
       from bakery.job_attempts a
       join bakery.jobs j
         on j.organization_id = a.organization_id and j.id = a.job_id
       join bakery.run_steps rs
         on rs.organization_id = j.organization_id and rs.id = j.run_step_id
       join bakery.workflow_runs wr
         on wr.organization_id = rs.organization_id and wr.id = rs.run_id
      where a.organization_id = $1 and a.id = $2`,
    [input.organizationId, input.attemptId],
  );
  const found = attempt.rows[0];
  if (!found) return { kind: "conflict" };
  const existing = await transaction.query<
    {
      id: string;
      organization_id: string;
      attempt_id: string;
      upstream_port: number;
      head_sha: string;
    }
  >(
    `select id, organization_id, attempt_id, upstream_port, head_sha
       from bakery.previews where route_key = $1 for update`,
    [input.routeKey],
  );
  const taken = existing.rows[0];
  if (taken) {
    const same = taken.organization_id === input.organizationId &&
      taken.attempt_id === input.attemptId &&
      taken.upstream_port === input.upstreamPort &&
      taken.head_sha === input.headSha;
    if (!same) return { kind: "conflict" };
    const preview = await readPreview(
      transaction,
      input.organizationId,
      taken.id,
    );
    return preview ? { kind: "replayed", preview } : { kind: "conflict" };
  }
  await transaction.query(
    `update bakery.previews
        set status = 'stopped', stop_reason = 'replaced', stopped_at = now(),
            updated_at = now(), version = version + 1
      where organization_id = $1 and job_id = $2 and attempt_id <> $3
        and status in ('starting', 'ready')`,
    [input.organizationId, found.job_id, input.attemptId],
  );
  const inserted = await transaction.query<{ id: string }>(
    `insert into bakery.previews
       (organization_id, run_id, job_id, attempt_id, head_sha, route_key,
        upstream_port, status, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, 'ready',
             now() + make_interval(secs => $8))
     returning id`,
    [
      input.organizationId,
      found.run_id,
      found.job_id,
      input.attemptId,
      input.headSha,
      input.routeKey,
      input.upstreamPort,
      RUNNING_PREVIEW_LIFETIME_SECONDS,
    ],
  );
  const preview = await readPreview(
    transaction,
    input.organizationId,
    inserted.rows[0].id,
  );
  if (!preview) return { kind: "conflict" };
  await announcePreview(transaction, {
    organizationId: input.organizationId,
    previewId: preview.id,
    runId: found.run_id,
    version: preview.version,
    eventType: "preview.ready",
    traceId: input.traceId,
  });
  return { kind: "created", preview };
}

const PREVIEWS_ORDERING = "createdAt:desc,id:desc";

export async function listPreviews(
  transaction: PgTransactionClient,
  scope: { organizationId: string; principalId: string },
  search: {
    runId?: string;
    status?: string;
    cursor?: string;
    limit?: number;
  },
  secret: string,
): Promise<{ items: PreviewView[]; nextCursor: string | null }> {
  const limit = search.limit ?? 25;
  const binding: CursorBinding = {
    action: "previews.list",
    principalId: scope.principalId,
    organizationId: scope.organizationId,
    ordering: PREVIEWS_ORDERING,
    filters: JSON.stringify({
      runId: search.runId ?? null,
      status: search.status ?? null,
    }),
    schemaVersion: 1,
  };
  const position = await decodeCursor(secret, search.cursor, binding);
  // The status filter applies to the state as read now, not the stored one.
  const rows = await transaction.query<
    PreviewRow & { cursor_created_at: string }
  >(
    `select * from (
       select ${PREVIEW_COLUMNS}, p.created_at as sort_created_at,
              ${iso("p.created_at")} as cursor_created_at
         ${PREVIEW_FROM}
        where p.organization_id = $1
          and ($2::uuid is null or p.run_id = $2)
     ) previews
      where ($3::text is null or status = $3)
        and ($4::timestamptz is null
             or (sort_created_at, id) < ($4, $5::uuid))
      order by sort_created_at desc, id desc
      limit $6`,
    [
      scope.organizationId,
      search.runId ?? null,
      search.status ?? null,
      position?.createdAt ?? null,
      position?.id ?? null,
      limit + 1,
    ],
  );
  const visible = rows.rows.slice(0, limit);
  const last = visible.at(-1);
  return {
    items: visible.map(toPreview),
    nextCursor: rows.rows.length > limit && last
      ? await encodeCursor(secret, binding, {
        createdAt: last.cursor_created_at,
        id: last.id,
      })
      : null,
  };
}

export type StopOutcome =
  | { kind: "stopped" | "already"; preview: PreviewView }
  | { kind: "missing" };

/**
 * Stops a live preview for everyone: the preview, every grant and every open
 * session end in one transaction. Stopping a preview that is already not live
 * changes nothing and reports its true state.
 */
export async function stopPreview(
  transaction: PgTransactionClient,
  organizationId: string,
  principalId: string,
  previewId: string,
  traceId: string,
): Promise<StopOutcome> {
  const locked = await transaction.query<{ status: string }>(
    `select status from bakery.previews
      where organization_id = $1 and id = $2 for update`,
    [organizationId, previewId],
  );
  if (!locked.rows[0]) return { kind: "missing" };
  const before = await readPreview(transaction, organizationId, previewId);
  if (!before) return { kind: "missing" };
  if (before.status === "stopped" || before.status === "expired") {
    return { kind: "already", preview: before };
  }
  await transaction.query(
    `update bakery.previews
        set status = 'stopped', stop_reason = 'person', stopped_by = $3,
            stopped_at = now(), updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2`,
    [organizationId, previewId, principalId],
  );
  await revokePreviewAccess(transaction, organizationId, previewId);
  const after = await readPreview(transaction, organizationId, previewId);
  if (!after) return { kind: "missing" };
  await announcePreview(transaction, {
    organizationId,
    previewId,
    runId: after.runId,
    version: after.version,
    eventType: "preview.stopped",
    traceId,
  });
  return { kind: "stopped", preview: after };
}

/** Ends every grant and session of one preview. Safe to repeat. */
export async function revokePreviewAccess(
  transaction: PgTransactionClient,
  organizationId: string,
  previewId: string,
): Promise<void> {
  await transaction.query(
    `update bakery.preview_grants set revoked_at = now()
      where organization_id = $1 and preview_id = $2 and revoked_at is null`,
    [organizationId, previewId],
  );
  await transaction.query(
    `update bakery.preview_sessions s set revoked_at = now()
       from bakery.preview_grants g
      where g.organization_id = $1 and g.preview_id = $2
        and s.organization_id = g.organization_id and s.grant_id = g.id
        and s.revoked_at is null`,
    [organizationId, previewId],
  );
}

export type IssuedAccessGrant = {
  grantId: string;
  secret: string;
  expiresAt: string;
};

/** Issues a one-use grant exchangeable for seconds, never for the session's length. */
export async function insertAccessGrant(
  transaction: PgTransactionClient,
  input: {
    organizationId: string;
    previewId: string;
    principalId: string;
    sessionSeconds: number;
  },
): Promise<IssuedAccessGrant> {
  const secret = randomPreviewSecret();
  const result = await transaction.query<{ id: string; expires_at: string }>(
    `insert into bakery.preview_grants
       (organization_id, preview_id, principal_id, token_hash,
        session_seconds, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))
     returning id, ${iso("expires_at")} as expires_at`,
    [
      input.organizationId,
      input.previewId,
      input.principalId,
      await sha256Hex(secret),
      input.sessionSeconds,
      PREVIEW_GRANT_TTL_SECONDS,
    ],
  );
  return {
    grantId: result.rows[0].id,
    secret,
    expiresAt: result.rows[0].expires_at,
  };
}

export async function readAccessGrantOwner(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
): Promise<
  { principalId: string; previewId: string; revoked: boolean } | null
> {
  const result = await transaction.query<
    { principal_id: string; preview_id: string; revoked_at: string | null }
  >(
    `select principal_id, preview_id, revoked_at from bakery.preview_grants
      where organization_id = $1 and id = $2 for update`,
    [organizationId, grantId],
  );
  const row = result.rows[0];
  return row
    ? {
      principalId: row.principal_id,
      previewId: row.preview_id,
      revoked: row.revoked_at !== null,
    }
    : null;
}

/** Ends one person's access: the grant and the sessions it opened. */
export async function revokeAccessGrant(
  transaction: PgTransactionClient,
  organizationId: string,
  grantId: string,
): Promise<void> {
  await transaction.query(
    `update bakery.preview_grants set revoked_at = now()
      where organization_id = $1 and id = $2 and revoked_at is null`,
    [organizationId, grantId],
  );
  await transaction.query(
    `update bakery.preview_sessions set revoked_at = now()
      where organization_id = $1 and grant_id = $2 and revoked_at is null`,
    [organizationId, grantId],
  );
}

/** The route key of a preview the caller can already read, for building its URL. */
export async function readRouteKey(
  transaction: PgTransactionClient,
  organizationId: string,
  previewId: string,
): Promise<string | null> {
  const result = await transaction.query<{ route_key: string }>(
    `select route_key from bakery.previews
      where organization_id = $1 and id = $2`,
    [organizationId, previewId],
  );
  return result.rows[0]?.route_key ?? null;
}

export type ExchangedRunningSession = {
  readonly secret: string;
  readonly sessionSeconds: number;
};

/**
 * One statement consumes an unexpired, unrevoked, unconsumed grant that was
 * issued for THIS preview (the route key of the host it was posted to) and
 * opens its session, so a replayed or racing exchange can win at most once and
 * a grant for one preview never opens another.
 */
export async function exchangeRunningGrant(
  database: PgDatabase,
  routeKey: string,
  grantSecret: string,
): Promise<ExchangedRunningSession | null> {
  const secret = randomPreviewSecret();
  const result = await database.query<{ session_seconds: number }>(
    `with consumed as (
       update bakery.preview_grants g
          set consumed_at = now()
         from bakery.previews p
        where g.token_hash = $1
          and g.consumed_at is null
          and g.revoked_at is null
          and g.expires_at > now()
          and p.organization_id = g.organization_id
          and p.id = g.preview_id
          and p.route_key = $2
        returning g.id, g.organization_id, g.session_seconds
     )
     insert into bakery.preview_sessions
       (organization_id, grant_id, session_hash, expires_at)
     select organization_id, id, $3, now() + make_interval(secs => session_seconds)
       from consumed
     returning (select session_seconds from consumed) as session_seconds`,
    [await sha256Hex(grantSecret), routeKey, await sha256Hex(secret)],
  );
  const row = result.rows[0];
  return row ? { secret, sessionSeconds: row.session_seconds } : null;
}

export type RunningSession = {
  readonly previewId: string;
  readonly upstreamPort: number;
  /** Whose authority the preview is served under: the grantor's. */
  readonly organizationId: string;
  readonly principalId: string;
};

/**
 * The preview a cookie may reach on this host, or null for every reason it may
 * not: unknown cookie, another preview's cookie, expired or revoked session or
 * grant, a preview that is not running now, or a grantor who is no longer an
 * active Developer or Admin of the organization. The reasons are not
 * distinguished, so nothing here tells a stranger what exists.
 */
export async function readRunningSession(
  database: PgDatabase,
  routeKey: string,
  cookieSecret: string,
): Promise<RunningSession | null> {
  const result = await database.query<
    {
      id: string;
      upstream_port: number;
      organization_id: string;
      principal_id: string;
    }
  >(
    `select p.id, p.upstream_port, p.organization_id, g.principal_id
       from bakery.preview_sessions s
       join bakery.preview_grants g
         on g.organization_id = s.organization_id and g.id = s.grant_id
       join bakery.previews p
         on p.organization_id = g.organization_id and p.id = g.preview_id
       join bakery.job_attempts a
         on a.organization_id = p.organization_id and a.id = p.attempt_id
       join bakery.jobs j
         on j.organization_id = a.organization_id and j.id = a.job_id
      where s.session_hash = $1
        and p.route_key = $2
        and s.revoked_at is null and s.expires_at > now()
        and g.revoked_at is null
        and (${STATE}) = 'ready'`,
    [await sha256Hex(cookieSecret), routeKey],
  );
  const row = result.rows[0];
  return row
    ? {
      previewId: row.id,
      upstreamPort: row.upstream_port,
      organizationId: row.organization_id,
      principalId: row.principal_id,
    }
    : null;
}

/**
 * Whose grant this is, for a grant that could still be exchanged on this
 * preview's origin, so the grantor can be re-authorized before it is spent.
 */
export async function readExchangeableGrantOwner(
  database: PgDatabase,
  routeKey: string,
  grantSecret: string,
): Promise<{ organizationId: string; principalId: string } | null> {
  const result = await database.query<
    { organization_id: string; principal_id: string }
  >(
    `select g.organization_id, g.principal_id
       from bakery.preview_grants g
       join bakery.previews p
         on p.organization_id = g.organization_id and p.id = g.preview_id
      where g.token_hash = $1 and p.route_key = $2
        and g.consumed_at is null and g.revoked_at is null
        and g.expires_at > now()`,
    [await sha256Hex(grantSecret), routeKey],
  );
  const row = result.rows[0];
  return row
    ? { organizationId: row.organization_id, principalId: row.principal_id }
    : null;
}
