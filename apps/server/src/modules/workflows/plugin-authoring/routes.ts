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
import {
  createApiRouter,
  problemResponse,
  StandardError,
} from "@bakery/contracts/http";
import type { ActionContext } from "@bakery/contracts/action-registry";
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
  type AuthoringTransaction,
  type PluginAuthoringDependencies,
  runPluginAuthoring,
  settleInterruptedRun,
} from "./runner.ts";

/**
 * Mounts the two authoring routes (#45, B14.04): start a run, read one back.
 *
 * Starting a run is a member's own business, like a personal install: the run
 * installs only for the caller, and revises only the caller's own install, so
 * the floor is Developer and the handler applies the owner rule.
 *
 * A run is long (generation, a typecheck, a preview), so its route does not
 * run inside one action transaction. It is mounted ahead of the JSON router,
 * like the page document read, and runs each of the run's short writes as its
 * own transaction through the action's authority, so every write re-checks the
 * caller's live membership and nothing holds a connection while code runs.
 * Reading a run settles it first if a crash left it running and stale.
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
    // Never reached: the route mounted ahead of the JSON router answers this
    // path, running the action's authority once per short transaction.
    handler: () => {
      throw new StandardError({ code: "INTERNAL" });
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
    handler: async (context) => {
      const runId = context.params.id ?? "";
      await settleInterruptedRun(context, runId, options.staleRunAfterMs);
      return await getPluginAuthoringRun(context, runId);
    },
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, pluginAuthoringImplementedActions);
  const authority = new PostgresAuthorityRunner(options.database);
  const createAction = registry.get(
    PluginAuthoringImplementedAction.PluginAuthoringRunsCreate,
  );
  app.post("/v1/plugin-authoring-runs", async (context) => {
    try {
      let body: unknown;
      try {
        body = await context.req.json();
      } catch {
        throw new StandardError({ code: "MALFORMED_REQUEST" });
      }
      const input = contractSchemas.PluginAuthoringRunCreate.parse(body);
      const base: ActionContext = {
        request: context.req.raw,
        params: {},
        requestId: context.req.header("x-request-id") ?? crypto.randomUUID(),
        traceId: context.req.header("x-trace-id") ?? crypto.randomUUID(),
        signal: context.req.raw.signal,
        ...createActionContext(context),
      };
      const tx: AuthoringTransaction = async <T>(
        work: (authorized: ActionContext) => Promise<T>,
      ) =>
        await authority.run(createAction, base, input, async (authorized) => {
          requireMember(authorized);
          return await work(authorized);
        }) as T;
      const runId = await runPluginAuthoring(tx, options, {
        request: input.request,
        authorizedCapabilities: input
          .authorizedCapabilities as PluginInstallCapability[],
        budgetUsd: Number(input.budgetUsd),
        maxAttempts: input.maxAttempts,
        ...(input.installId === undefined
          ? {}
          : { installId: input.installId }),
      });
      const run = await tx((authorized) =>
        getPluginAuthoringRun(authorized, runId)
      );
      return context.json(contractSchemas.PluginAuthoringRun.parse(run), 201);
    } catch (error) {
      return problemResponse(context, error, {
        publicBaseUrl: options.publicBaseUrl,
      });
    }
  });
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
