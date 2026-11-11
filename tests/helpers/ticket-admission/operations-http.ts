/**
 * HTTP helpers for the issue 82 operation lanes. Not a test module: it only
 * exports. Calls go through the production app the fixture mounted, with the
 * fixture's in-memory GitHub reader behind the ticket routes.
 */
import { assertEquals } from "@std/assert";
import { orgHeader } from "../account-settings.ts";
import { call } from "../installation-settings.ts";
import type { TicketFixture } from "./fixtures.ts";

export type Json = Record<string, unknown>;

/** The parts of a `TicketSource` body the lanes read. */
export type SourceView = {
  id: string;
  version: number;
  policyRevision: number;
  enabled: boolean;
  syncHealth: string;
  lastSyncedAt: string | null;
  lastProblemCode: string | null;
  policy: Json & { automatic: { enabled: boolean; since: string | null } };
};

/** A problem body. */
export type Problem = {
  code: string;
  reason?: string;
  status: number;
  issues?: { path: unknown[]; code: string }[];
};

/** The parsed body of `response`, which must have answered `status`. */
export async function read<T = Json>(
  response: Response,
  status: number,
): Promise<T> {
  assertEquals(response.status, status, await response.clone().text());
  return await response.json() as T;
}

/** One request as the fixture's Admin unless `cookie` says otherwise. */
export function ticketCall(
  fx: Pick<TicketFixture, "f" | "organizationId">,
  method: string,
  path: string,
  options: {
    body?: unknown;
    cookie?: string;
    organizationId?: string;
    /** `null` sends no Idempotency-Key. */
    key?: string | null;
    ifMatch?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    ...orgHeader(options.organizationId ?? fx.organizationId),
    ...(method === "GET" || options.key === null
      ? {}
      : { "Idempotency-Key": options.key ?? crypto.randomUUID() }),
    ...(options.ifMatch === undefined
      ? {}
      : { "If-Match": `"v${options.ifMatch}"` }),
    ...options.headers,
  };
  return call(fx.f, method, path, options.cookie ?? fx.f.adminCookie, {
    body: options.body,
    headers,
  });
}

/** The body `ticketSources.create` takes for the fixture's repository. */
export function sourceBody(
  fx: TicketFixture,
  overrides: Record<string, unknown> = {},
): Json {
  return {
    connectionId: fx.connectionId,
    resourceId: fx.resource.id,
    applicationId: fx.applicationId,
    repositoryId: fx.repositoryId,
    externalContainerId: fx.resource.external_id,
    policy: fx.policy(),
    ...overrides,
  };
}

/** Audit rows, domain events and outbox rows a resource has, oldest first. */
export async function factsOf(
  fx: Pick<TicketFixture, "owner" | "organizationId">,
  resourceType: string,
  resourceId: string,
): Promise<{ audit: string[]; events: string[]; outbox: number }> {
  const audit = await fx.owner.query<{ operation: string }>(
    `select operation from bakery.audit_events
      where organization_id = $1 and resource_type = $2
        and resource_id = $3 order by created_at, id`,
    [fx.organizationId, resourceType, resourceId],
  );
  const events = await fx.owner.query<{ event_type: string }>(
    `select event_type from bakery.domain_events
      where organization_id = $1 and aggregate_id = $2 order by sequence`,
    [fx.organizationId, resourceId],
  );
  const outbox = await fx.owner.query(
    `select 1 from bakery.outbox outbox
       join bakery.domain_events event on event.id = outbox.event_id
      where event.organization_id = $1 and event.aggregate_id = $2`,
    [fx.organizationId, resourceId],
  );
  return {
    audit: audit.rows.map((row) => row.operation),
    events: events.rows.map((row) => row.event_type),
    outbox: outbox.rows.length,
  };
}

/** Audit rows, domain events and outbox rows a source has, oldest first. */
export function sourceFacts(
  fx: Pick<TicketFixture, "owner" | "organizationId">,
  sourceId: string,
) {
  return factsOf(fx, "ticket_source", sourceId);
}

/**
 * Application-role backends holding a transaction open while idle. Run as the
 * application role: another role's session state is hidden from the owner.
 */
export async function idleInTransaction(
  fx: Pick<TicketFixture, "runtime">,
): Promise<number> {
  const result = await fx.runtime.query<{ n: number }>(
    `select count(*)::int as n from pg_stat_activity
      where datname = current_database() and usename = current_user
        and state = 'idle in transaction' and pid <> pg_backend_pid()`,
  );
  return result.rows[0].n;
}

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
