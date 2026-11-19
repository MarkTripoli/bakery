import { Hono, type MiddlewareHandler } from "hono";
import type { z } from "zod";
import {
  type ActionContext,
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  IntegrationProviderSetupImplementedAction as Action,
  integrationProviderSetupImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter } from "@bakery/contracts/http";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import { requireWorkTransaction } from "../work/work-transaction.ts";
import { PROVIDER_IDENTITIES, PROVIDERS } from "./registry.ts";

/**
 * integrationProviderSetup.list (#410): which deployed providers are ready to connect.
 *
 * Installation administrators register a provider's application; everyone who can
 * see integrations needs to tell whether that has happened, so a provider that is
 * not set up can say so instead of failing when someone presses Connect. This is
 * that one fact per provider, with no credential and nothing about what was
 * registered.
 *
 * A provider needs registration when it is GitHub (an App) or its manifest asks for
 * an application registration; one that asks for none is ready by definition.
 * Order is the registry's, so the page is stable.
 */

type SetupList = z.output<typeof contractSchemas.IntegrationProviderSetupList>;

export async function listProviderSetup(
  context: ActionContext,
): Promise<SetupList> {
  const { transaction } = requireWorkTransaction(context);
  const registered = new Set(
    (await transaction.query<{ provider: string }>(
      "select provider from bakery.integration_app_registrations",
    )).rows.map((row) => row.provider),
  );
  return {
    providers: PROVIDER_IDENTITIES.map(({ slug }) => {
      const manifest = PROVIDERS.get(slug)?.manifest;
      // GitHub predates the provider registry and is always an App; any other
      // provider is registered only if its manifest says it needs to be.
      const needsRegistration = slug === "github" ||
        (manifest !== undefined && manifest.appRegistration !== null);
      return {
        provider: slug,
        setupState: !needsRegistration || registered.has(slug)
          ? "ready" as const
          : "needs_setup" as const,
      };
    }),
  };
}

export function createProviderSetupActionRegistry(
  database: PgDatabase,
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  registry.register({
    name: Action.IntegrationProviderSetupList,
    method: HttpMethod.Get,
    path: "/v1/integration-provider-setup",
    input: contractSchemas.Empty,
    output: contractSchemas.IntegrationProviderSetupList,
    policy: {
      type: ActionKind.Query,
      // The same access as listing connections, which is what the page already
      // shows to the same people.
      access: ActionAccess.Developer,
      organizationContext:
        OrganizationContextPolicy.RequiredAuthenticatedContext,
    },
    handler: (context) => listProviderSetup(context),
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(
    registry,
    integrationProviderSetupImplementedActions,
  );
  return registry;
}

export function createProviderSetupRoutes(options: {
  database: PgDatabase;
  browserSession: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/integration-provider-setup", options.browserSession);
  app.route(
    "/",
    createApiRouter({
      registry: createProviderSetupActionRegistry(options.database),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
