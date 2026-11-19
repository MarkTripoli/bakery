import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  ProviderReadsImplementedAction,
  providerReadsImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";

/**
 * The five provider reads (#26 slice 2).
 *
 * Every one is a `Query` at Developer access with a required organization
 * context: a route belongs to an organization, and a caller outside it has no
 * business knowing the organization runs an expired credential. That is also why
 * the reads are organization-scoped in the query rather than filtered after the
 * fact - a row from another organization is never loaded, so it cannot leak
 * through a missing filter.
 */
export type ProviderReadHandlers = {
  listRoutes: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ProviderRouteQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<ProviderRoute>"]>>;
  getRoute: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.ProviderRoute>>;
  getRouteHealth: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.RouteHealth>>;
  listIncidents: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.ProviderIncidentQuery>,
  ) => Promise<z.output<typeof contractSchemas["Page<ProviderIncident>"]>>;
  getIncident: (
    context: ActionContext,
    input: z.output<typeof contractSchemas.IdPath>,
  ) => Promise<z.output<typeof contractSchemas.ProviderIncident>>;
};

export function createProviderReadActionRegistry(
  database: PgDatabase,
  handlers: ProviderReadHandlers,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const readPolicy = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext: OrganizationContextPolicy.RequiredAuthenticatedContext,
  } as const;

  registry.register({
    name: ProviderReadsImplementedAction.ProviderRoutesList,
    method: HttpMethod.Get,
    path: "/v1/provider-routes",
    input: contractSchemas.ProviderRouteQuery,
    output: contractSchemas["Page<ProviderRoute>"],
    policy: readPolicy,
    handler: handlers.listRoutes,
  });
  registry.register({
    name: ProviderReadsImplementedAction.ProviderRoutesGet,
    method: HttpMethod.Get,
    path: "/v1/provider-routes/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.ProviderRoute,
    policy: readPolicy,
    handler: handlers.getRoute,
  });
  registry.register({
    name: ProviderReadsImplementedAction.ProviderRoutesHealth,
    method: HttpMethod.Get,
    path: "/v1/provider-routes/:id/health",
    input: contractSchemas.IdPath,
    output: contractSchemas.RouteHealth,
    policy: readPolicy,
    handler: handlers.getRouteHealth,
  });
  registry.register({
    name: ProviderReadsImplementedAction.ProviderIncidentsList,
    method: HttpMethod.Get,
    path: "/v1/provider-incidents",
    input: contractSchemas.ProviderIncidentQuery,
    output: contractSchemas["Page<ProviderIncident>"],
    policy: readPolicy,
    handler: handlers.listIncidents,
  });
  registry.register({
    name: ProviderReadsImplementedAction.ProviderIncidentsGet,
    method: HttpMethod.Get,
    path: "/v1/provider-incidents/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.ProviderIncident,
    policy: readPolicy,
    handler: handlers.getIncident,
  });

  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, providerReadsImplementedActions);
  return registry;
}
