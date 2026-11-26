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
import { isPostgresForeignKeyRefusal } from "../../platform/postgres-errors.ts";
import { isNonPublicAddress } from "./provider-egress.ts";
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

/**
 * A route endpoint must be an https origin and path a provider serves, and must
 * not carry what the contract says it never carries: credentials or a query
 * secret. Refused as unprocessable on the `endpoint` field.
 *
 * The host is judged as the resolver will see it. A fully-qualified name may end
 * in one dot (`localhost.` is `localhost`), so one trailing dot is dropped before
 * any comparison. A name with no dot at all is refused: it is not a public
 * provider, and a bare name resolves through the server's search domain to
 * whatever internal service carries it (`db`, `redis`, `consul`). Names under a
 * suffix that only ever means "inside" are refused too: `.local`, `.internal`,
 * `.localhost`, `.localdomain`, and `.svc` (a Kubernetes service; its
 * `.cluster.local` form is already `.local`). Port 0 is not a port a provider
 * serves.
 */
export function assertProviderEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw unprocessable(["endpoint"], "provider_endpoint_invalid");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const isAddress = host.includes(":") || /^[0-9.]+$/.test(host);
  const refused = url.protocol !== "https:" || url.username !== "" ||
    url.password !== "" || url.search !== "" || url.hash !== "" ||
    url.port === "0" || host === "" || host.endsWith(".") ||
    (!isAddress && !host.includes(".")) || host === "localhost" ||
    host.endsWith(".localhost") || host.endsWith(".local") ||
    host.endsWith(".internal") || host.endsWith(".localdomain") ||
    host.endsWith(".svc") || isNonPublicAddress(host);
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
    if (isPostgresForeignKeyRefusal(error)) {
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
