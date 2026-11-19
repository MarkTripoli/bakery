import type { z } from "zod";
import type { ActionContext } from "@bakery/contracts/action-registry";
import type { contractSchemas } from "@bakery/contracts/contracts";
import {
  requireCommandMetadata,
  StandardError,
  unprocessable,
} from "@bakery/contracts/http";
import {
  appendAudit,
  appendDomainEvent,
  nextAggregateVersion,
} from "@bakery/persistence";
import type { PgTransactionClient } from "../../platform/database.ts";
import { postgresErrorCode } from "../../platform/postgres-errors.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import {
  type ProviderRouteRow,
  ROUTE_COLUMNS,
  toProviderRoute,
} from "./provider-reads.ts";

/**
 * The provider route writes (#26 slice 2, writes): register a route, and change
 * its lifecycle status or region.
 *
 * A route is configuration, not a decision. Creating one says where work may be
 * sent; it does not say the place is up. A new route is `active` and
 * `unverified` with no incident, and only the probe that a later slice adds moves
 * its circuit state. These commands never touch `health`, the incident or
 * `inferenceVerifiedAt`, so an operator cannot mark a route healthy by editing it.
 *
 * Identity is immutable. Provider, endpoint, model, harness, billing route,
 * credential location, account and binding are what an incident, a probe result
 * and a continuation choice were made *about*; changing one in place would make
 * every earlier record describe a route that no longer exists. A different
 * endpoint or model is a new route.
 */

type RouteCreate = z.output<typeof contractSchemas.ProviderRouteCreate>;
type RouteUpdate = z.output<typeof contractSchemas.ProviderRouteUpdate>;
type RouteOutput = z.output<typeof contractSchemas.ProviderRoute>;

/** SQLSTATE for a foreign-key violation: the account or binding is not in this organization. */
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";

/**
 * Whether an address literal is one a public provider can never have: loopback,
 * private, link-local (which includes the cloud metadata address), unspecified or
 * unique-local. A route's endpoint is called by the server, so a value that names
 * the server's own network is a request to read it (SSRF), whatever the route is
 * for. This is the static half of the rule: it sees only what is written in the
 * URL, so a name that *resolves* to such an address is the probe's to refuse at
 * connect time.
 */
function isNonPublicAddress(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.startsWith("[") || host.includes(":")) {
    const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
    return bare === "::" || bare === "::1" || bare.startsWith("fe80") ||
      bare.startsWith("fc") || bare.startsWith("fd") ||
      bare.startsWith("::ffff:");
  }
  return false;
}

/**
 * A route endpoint must be an https origin and path a provider serves, and must
 * not carry what the contract says it never carries: credentials or a query
 * secret. Refused as unprocessable on the `endpoint` field.
 */
export function assertProviderEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw unprocessable(["endpoint"], "provider_endpoint_invalid");
  }
  const host = url.hostname.toLowerCase();
  const refused = url.protocol !== "https:" || url.username !== "" ||
    url.password !== "" || url.search !== "" || url.hash !== "" ||
    host === "" || host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal") ||
    isNonPublicAddress(host);
  if (refused) {
    throw unprocessable(["endpoint"], "provider_endpoint_invalid");
  }
}

/** The route's audit row and domain event, in the command's own transaction. */
async function recordRouteFact(
  context: ActionContext,
  transaction: PgTransactionClient,
  actor: { organizationId: string; principalId: string },
  route: RouteOutput,
  operation: string,
  eventType: string,
): Promise<void> {
  await appendAudit(transaction, {
    organizationId: actor.organizationId,
    principalId: actor.principalId,
    operation,
    resourceType: "provider_route",
    resourceId: route.id,
    requestId: context.requestId,
    traceId: context.traceId,
    details: { version: route.version },
  });
  await appendDomainEvent(transaction, {
    organizationId: actor.organizationId,
    applicationId: null,
    repositoryId: null,
    eventType,
    aggregateId: route.id,
    aggregateVersion: await nextAggregateVersion(
      transaction,
      actor.organizationId,
      route.id,
      eventType,
    ),
    payload: { resourceId: route.id, resourceVersion: route.version },
    traceId: context.traceId,
  });
}

/**
 * POST /v1/provider-routes.
 *
 * The account and binding ids are checked by the table's own composite keys,
 * `(organization_id, id)`, so an id that belongs to another organization is
 * refused exactly like one that does not exist. The caller learns nothing about
 * another organization's accounts either way.
 */
export async function createProviderRoute(
  context: ActionContext,
  input: unknown,
): Promise<RouteOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as RouteCreate;
  assertProviderEndpoint(value.endpoint);
  let row: ProviderRouteRow | undefined;
  try {
    const inserted = await transaction.query<ProviderRouteRow>(
      `insert into bakery.provider_routes (
         id, organization_id, provider, endpoint, region, model, harness,
         billing_route, provider_account_id, worker_binding_id,
         credential_location
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${ROUTE_COLUMNS}`,
      [
        crypto.randomUUID(),
        organizationId,
        value.provider,
        value.endpoint,
        value.region ?? null,
        value.model,
        value.harness,
        value.billingRoute,
        value.providerAccountId ?? null,
        value.workerBindingId ?? null,
        value.credentialLocation,
      ],
    );
    row = inserted.rows[0];
  } catch (error) {
    if (postgresErrorCode(error) === POSTGRES_FOREIGN_KEY_VIOLATION) {
      throw unprocessable(
        ["providerAccountId", "workerBindingId"],
        "provider_route_binding_unknown",
        error,
      );
    }
    throw error;
  }
  if (!row) throw new Error("PROVIDER_ROUTE_INSERT_FAILED");
  const route = toProviderRoute(row);
  await recordRouteFact(
    context,
    transaction,
    { organizationId, principalId },
    route,
    "providerRoutes.create",
    "providerRoutes.created",
  );
  return route;
}

/**
 * PATCH /v1/provider-routes/{id}: compare-and-swap on `version`.
 *
 * The row is locked, then judged, then written, so two administrators changing
 * the same route cannot both pass the check against one version. `revoked` is
 * permanent: it is the one state a route cannot leave, and a revoked route
 * refuses every edit rather than only a status change, because nothing about a
 * route that can never serve work again is worth editing.
 *
 * Leaving `active` also clears the probe schedule, because a route that is not
 * probed must not advertise when it will be. Coming back to `active` does not
 * set one: scheduling a probe is the monitor's decision, not an edit's.
 */
export async function updateProviderRoute(
  context: ActionContext,
  input: unknown,
): Promise<RouteOutput> {
  const { transaction, organizationId, principalId } = requireWorkTransaction(
    context,
  );
  const value = input as RouteUpdate;
  const routeId = context.params.id;
  if (!routeId) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  const expectedVersion = requireCommandMetadata(context).expectedVersion;
  if (expectedVersion === undefined) {
    throw new StandardError({ code: "PRECONDITION_REQUIRED" });
  }

  const current = (await transaction.query<ProviderRouteRow>(
    `select ${ROUTE_COLUMNS}
       from bakery.provider_routes
      where organization_id = $1 and id = $2
        for update`,
    [organizationId, routeId],
  )).rows[0];
  if (!current) throw new StandardError({ code: "RESOURCE_NOT_FOUND" });
  if (current.version !== expectedVersion) {
    throw new StandardError({ code: "PRECONDITION_FAILED" });
  }
  if (current.status === "revoked") {
    throw new StandardError({
      code: "STATE_CONFLICT",
      params: { reason: "provider_route_revoked" },
    });
  }

  const statusChanges = value.status !== undefined &&
    value.status !== current.status;
  const regionChanges = value.region !== undefined &&
    value.region !== current.region;
  if (!statusChanges && !regionChanges) {
    throw unprocessable([], "provider_route_update_changes_nothing");
  }
  const leavesActive = statusChanges && value.status !== "active";

  const updated = await transaction.query<ProviderRouteRow>(
    `update bakery.provider_routes
        set status = case when $3::boolean then $4 else status end,
            region = case when $5::boolean then $6 else region end,
            next_probe_at = case when $7::boolean then null else next_probe_at end,
            updated_at = now(), version = version + 1
      where organization_id = $1 and id = $2
      returning ${ROUTE_COLUMNS}`,
    [
      organizationId,
      routeId,
      statusChanges,
      value.status ?? null,
      regionChanges,
      value.region ?? null,
      leavesActive,
    ],
  );
  const row = updated.rows[0];
  if (!row) throw new Error("PROVIDER_ROUTE_UPDATE_FAILED");
  if (leavesActive) {
    await transaction.query(
      `update bakery.provider_route_health
          set next_probe_at = null, probe_lease_expires_at = null,
              updated_at = now()
        where organization_id = $1 and route_id = $2`,
      [organizationId, routeId],
    );
  }
  const route = toProviderRoute(row);
  await recordRouteFact(
    context,
    transaction,
    { organizationId, principalId },
    route,
    "providerRoutes.update",
    "providerRoutes.updated",
  );
  return route;
}
