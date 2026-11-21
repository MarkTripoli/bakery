import { Hono, type MiddlewareHandler } from "hono";
import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  assertImplementedActionRegistry,
  PluginAuthoringImplementedAction,
  pluginAuthoringImplementedActions,
} from "@bakery/contracts/implemented-actions";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import { createApiRouter, StandardError } from "@bakery/contracts/http";
import type { PluginInstallCapability } from "@bakery/contracts/plugin-sdk";
import { PostgresAuthorityRunner } from "../../auth/adapters/authority-postgres.ts";
import { isOrganizationMember } from "../../auth/application/authorize.ts";
import type { OrganizationActor } from "../../auth/application/authority.ts";
import {
  type AuthVariables,
  createActionContext,
} from "../../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../../platform/command-replay.ts";
import type { PgDatabase } from "../../../platform/database.ts";
import { getPluginAuthoringRun } from "./read.ts";
import {
  type PluginAuthoringDependencies,
  runPluginAuthoring,
} from "./runner.ts";

/**
 * Mounts the two authoring routes (#45, B14.04): start a run, read one back.
 *
 * Starting a run is a member's own business, like a personal install: the run
 * installs only for the caller, and revises only the caller's own install, so
 * the floor is Developer and the handler applies the owner rule. No route lets
 * a caller set the checks' policy beyond the capabilities they authorize.
 */
export function createPluginAuthoringRoutes(
  options: {
    database: PgDatabase;
    browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
    publicBaseUrl: string;
  } & PluginAuthoringDependencies,
) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/plugin-authoring-runs", options.browserSession);
  app.use("/v1/plugin-authoring-runs/*", options.browserSession);
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(options.database),
    createPostgresCommandRunner(),
  );
  const requireMember = (context: unknown): void => {
    const authority = (context as { authority?: unknown }).authority;
    if (
      typeof authority !== "object" || authority === null ||
      !("organizationId" in authority) ||
      !isOrganizationMember(authority as OrganizationActor)
    ) {
      throw new StandardError({ code: "AUTH_FORBIDDEN" });
    }
  };
  const memberContext = OrganizationContextPolicy.RequiredAuthenticatedContext;
  registry.register({
    name: PluginAuthoringImplementedAction.PluginAuthoringRunsCreate,
    method: HttpMethod.Post,
    path: "/v1/plugin-authoring-runs",
    input: contractSchemas.PluginAuthoringRunCreate,
    output: contractSchemas.PluginAuthoringRun,
    policy: {
      type: ActionKind.Command,
      access: ActionAccess.Developer,
      organizationContext: memberContext,
      authorize: requireMember,
    },
    explicitIdempotency: "key",
    handler: async (context, input) => {
      const runId = await runPluginAuthoring(context, options, {
        request: input.request,
        authorizedCapabilities: input
          .authorizedCapabilities as PluginInstallCapability[],
        budgetUsd: Number(input.budgetUsd),
        maxAttempts: input.maxAttempts,
        ...(input.installId === undefined
          ? {}
          : { installId: input.installId }),
      });
      return await getPluginAuthoringRun(context, runId);
    },
  });
  registry.register({
    name: PluginAuthoringImplementedAction.PluginAuthoringRunsGet,
    method: HttpMethod.Get,
    path: "/v1/plugin-authoring-runs/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.PluginAuthoringRun,
    policy: {
      type: ActionKind.Query,
      access: "Authorized owner/member",
      organizationContext: memberContext,
      authorize: requireMember,
    },
    handler: (context) =>
      getPluginAuthoringRun(context, context.params.id ?? ""),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, pluginAuthoringImplementedActions);
  app.route(
    "/",
    createApiRouter({
      registry,
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
