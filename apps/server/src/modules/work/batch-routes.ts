import { Hono, type MiddlewareHandler } from "hono";
import {
  ActionKind,
  ActionRegistry,
  assertRegisteredActions,
  HttpMethod,
  TransactionIsolation,
} from "@bakery/contracts/action-registry";
import {
  ActionAccess,
  contractSchemas,
  OrganizationContextPolicy,
} from "@bakery/contracts/contracts";
import {
  assertImplementedActionRegistry,
  BatchImplementedAction as Action,
  batchImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter } from "@bakery/contracts/http";
import type { ActionContext } from "@bakery/contracts/action-registry";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import type { BudgetRuntimeConfig } from "@bakery/config";
import { authorizeTicketAdmission } from "./ticket-request-command.ts";
import { createBatchStartableHandler } from "./batch-startable.ts";
import {
  createBatchesListHandler,
  createBatchHandler,
  finishBatch,
  getBatch,
  pauseBatch,
  resumeBatch,
  startNextInBatch,
  stopBatch,
} from "./batch-commands.ts";

/** The batch registry (#58): start, read and control a bounded run of issues. */
export function createBatchActionRegistry(
  database: PgDatabase,
  dependencies: {
    cursorSecret: string;
    budget: BudgetRuntimeConfig | undefined;
  },
): ActionRegistry {
  const registry = new ActionRegistry(
    new PostgresAuthorityRunner(database),
    createPostgresCommandRunner(),
  );
  const organizationContext =
    OrganizationContextPolicy.RequiredAuthenticatedContext;
  const query = {
    type: ActionKind.Query,
    access: ActionAccess.Developer,
    organizationContext,
  } as const;
  // Starting and steering a batch needs the authority to start work itself.
  const command = {
    type: ActionKind.Command,
    access: ActionAccess.DeveloperAndAdmissionAuthority,
    organizationContext,
    // The runner trusts only the three base access levels on their own; this one needs
    // a guard of its own, and it is the same one a ticket request needs: the caller
    // holds task:write and run:write.
    authorize: (context: ActionContext) => authorizeTicketAdmission(context),
  } as const;
  const control = (
    name: typeof Action[keyof typeof Action],
    path: string,
    input: typeof contractSchemas.Empty | typeof contractSchemas.BatchStop,
    handler: never,
  ) =>
    registry.register({
      name,
      method: HttpMethod.Post,
      path,
      input,
      output: contractSchemas.Batch,
      policy: command,
      handler,
    } as never);

  registry.register({
    name: Action.BatchesList,
    method: HttpMethod.Get,
    path: "/v1/batches",
    input: contractSchemas.BatchQuery,
    output: contractSchemas["Page<Batch>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createBatchesListHandler(dependencies.cursorSecret),
  }).register({
    // Before `/v1/batches/:id`, so "startable" is never read as a batch id.
    name: Action.BatchesStartable,
    method: HttpMethod.Get,
    path: "/v1/batches/startable",
    input: contractSchemas.BatchStartableQuery,
    output: contractSchemas.BatchStartable,
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createBatchStartableHandler(dependencies),
  }).register({
    name: Action.BatchesGet,
    method: HttpMethod.Get,
    path: "/v1/batches/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.Batch,
    policy: query,
    handler: getBatch,
  }).register({
    name: Action.BatchesCreate,
    method: HttpMethod.Post,
    path: "/v1/batches",
    input: contractSchemas.BatchCreate,
    output: contractSchemas.Batch,
    policy: command,
    handler: createBatchHandler(dependencies),
  });
  control(
    Action.BatchesPause,
    "/v1/batches/:id/pause",
    contractSchemas.Empty,
    pauseBatch as never,
  );
  control(
    Action.BatchesResume,
    "/v1/batches/:id/resume",
    contractSchemas.Empty,
    resumeBatch as never,
  );
  control(
    Action.BatchesStop,
    "/v1/batches/:id/stop",
    contractSchemas.BatchStop,
    stopBatch as never,
  );
  control(
    Action.BatchesStartNext,
    "/v1/batches/:id/start-next",
    contractSchemas.Empty,
    startNextInBatch as never,
  );
  control(
    Action.BatchesFinish,
    "/v1/batches/:id/finish",
    contractSchemas.Empty,
    finishBatch as never,
  );
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, batchImplementedActions);
  return registry;
}

/** Batch routes, behind the token-accepting session like the other work routes. */
export function createBatchRoutes(options: {
  database: PgDatabase;
  session: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
  budget: BudgetRuntimeConfig | undefined;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("/v1/batches", options.session);
  app.use("/v1/batches/*", options.session);
  app.route(
    "/",
    createApiRouter({
      registry: createBatchActionRegistry(options.database, options),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
