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
  McpServerImplementedAction as Action,
  mcpServerImplementedActions,
} from "@bakery/contracts/implemented-actions";
import { createApiRouter } from "@bakery/contracts/http";
import { PostgresAuthorityRunner } from "../auth/adapters/authority-postgres.ts";
import { type AuthVariables, createActionContext } from "../auth/middleware.ts";
import { createPostgresCommandRunner } from "../../platform/command-replay.ts";
import type { PgDatabase } from "../../platform/database.ts";
import {
  createMcpServer,
  createMcpServersListHandler,
  getMcpServer,
  updateMcpServer,
} from "./server-commands.ts";

/** The MCP management registry: server definitions (#434), growing as slices land. */
export function createMcpActionRegistry(
  database: PgDatabase,
  dependencies: { cursorSecret: string },
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
  const admin = {
    type: ActionKind.Command,
    access: ActionAccess.Admin,
    organizationContext,
  } as const;

  registry.register({
    name: Action.McpServersList,
    method: HttpMethod.Get,
    path: "/v1/mcp-servers",
    input: contractSchemas.CursorQuery,
    output: contractSchemas["Page<McpServer>"],
    policy: query,
    transactionIsolation: TransactionIsolation.RepeatableRead,
    handler: createMcpServersListHandler(dependencies.cursorSecret),
  }).register({
    name: Action.McpServersGet,
    method: HttpMethod.Get,
    path: "/v1/mcp-servers/:id",
    input: contractSchemas.IdPath,
    output: contractSchemas.McpServer,
    policy: query,
    handler: getMcpServer,
  }).register({
    name: Action.McpServersCreate,
    method: HttpMethod.Post,
    path: "/v1/mcp-servers",
    input: contractSchemas.McpServerCreate,
    output: contractSchemas.McpServer,
    policy: admin,
    handler: createMcpServer,
  }).register({
    name: Action.McpServersUpdate,
    method: HttpMethod.Patch,
    path: "/v1/mcp-servers/:id",
    input: contractSchemas.McpServerUpdate,
    output: contractSchemas.McpServer,
    policy: admin,
    handler: updateMcpServer,
  });
  assertRegisteredActions(registry);
  assertImplementedActionRegistry(registry, mcpServerImplementedActions);
  return registry;
}

/** MCP management routes (not Bakery's own MCP endpoint), behind the token-accepting session like the other resource routes. */
export function createMcpManagementRoutes(options: {
  database: PgDatabase;
  session: MiddlewareHandler<{ Variables: AuthVariables }>;
  publicBaseUrl: string;
  cursorSecret: string;
}) {
  const app = new Hono<{ Variables: AuthVariables }>();
  for (const path of ["/v1/mcp-servers"]) {
    app.use(path, options.session);
    app.use(`${path}/*`, options.session);
  }
  app.route(
    "/",
    createApiRouter({
      registry: createMcpActionRegistry(options.database, options),
      publicBaseUrl: options.publicBaseUrl,
      createContext: createActionContext,
    }),
  );
  return app;
}
